/**
 * Network tools for Android devices.
 *
 * Provides 4 tool handlers:
 *   - network_traffic:      App (or global) network traffic stats from kernel counters
 *   - network_connectivity: Active connection type, IP, DNS, WiFi state
 *   - network_proxy:        Get / set / clear the global HTTP proxy setting
 *   - network_airplane:     Enable or disable airplane mode
 *
 * All tools are Android-only — they return a clear error on other platforms.
 */

import type { ToolDefinition } from "./registry.js";
import { ValidationError } from "../errors.js";
import { truncateOutput } from "../utils/truncate.js";
import { validatePackageName } from "../utils/sanitize.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ANDROID_ONLY_MSG = (tool: string) =>
  `${tool} is only available for Android.`;

/** Hostname validation: alphanumeric, dots, hyphens; must start with alphanumeric. */
const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9.\-]*$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format raw byte count as a human-readable string.
 * Examples: 512 → "512 B", 1536 → "1.5 KB", 2097152 → "2.0 MB"
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Parse a uid from `cmd package list packages -U <pkg>` output.
 * The line looks like: "package:com.example.app uid:10123"
 * Returns null if not found.
 */
function parseUid(output: string): string | null {
  const match = output.match(/uid:(\d+)/);
  return match ? match[1] : null;
}

/**
 * Parse /proc/net/xt_qtaguid/stats for a given uid.
 * File columns (space-separated): idx iface acct_tag_hex uid_tag_int cnt_set rx_bytes rx_packets tx_bytes tx_packets ...
 * Returns aggregated { rxBytes, txBytes, rxPackets, txPackets } across all interfaces and sets.
 */
function parseQtaguidStats(raw: string, uid: string): {
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
} {
  let rxBytes = 0, txBytes = 0, rxPackets = 0, txPackets = 0;
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s+/);
    // cols[3] = uid_tag_int (uid with tag, lower 32 bits is UID)
    if (cols.length < 9) continue;
    const lineUid = String(parseInt(cols[3], 10) & 0xffffffff);
    if (lineUid !== uid) continue;
    rxBytes   += parseInt(cols[5], 10) || 0;
    rxPackets += parseInt(cols[6], 10) || 0;
    txBytes   += parseInt(cols[7], 10) || 0;
    txPackets += parseInt(cols[8], 10) || 0;
  }
  return { rxBytes, txBytes, rxPackets, txPackets };
}

/**
 * Parse a summary line from `dumpsys netstats` for global totals.
 * Looks for lines like:
 *   Xt stats:
 *     iface=wlan0 ... rxBytes=1234 rxPackets=5 txBytes=6789 txPackets=10
 * Returns an array of interface summaries.
 */
function parseNetstatsGlobal(raw: string): Array<{
  iface: string;
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
}> {
  const results: Array<{
    iface: string;
    rxBytes: number;
    txBytes: number;
    rxPackets: number;
    txPackets: number;
  }> = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("iface=")) continue;

    const iface     = trimmed.match(/iface=(\S+)/)?.[1]       ?? "unknown";
    const rxBytes   = parseInt(trimmed.match(/rxBytes=(\d+)/)?.[1]   ?? "0", 10);
    const rxPackets = parseInt(trimmed.match(/rxPackets=(\d+)/)?.[1] ?? "0", 10);
    const txBytes   = parseInt(trimmed.match(/txBytes=(\d+)/)?.[1]   ?? "0", 10);
    const txPackets = parseInt(trimmed.match(/txPackets=(\d+)/)?.[1] ?? "0", 10);

    // Avoid duplicate zero-rows from header sections
    if (rxBytes === 0 && txBytes === 0 && rxPackets === 0 && txPackets === 0) continue;

    // Aggregate same-interface entries (there may be multiple history buckets)
    const existing = results.find(r => r.iface === iface);
    if (existing) {
      existing.rxBytes   += rxBytes;
      existing.txBytes   += txBytes;
      existing.rxPackets += rxPackets;
      existing.txPackets += txPackets;
    } else {
      results.push({ iface, rxBytes, txBytes, rxPackets, txPackets });
    }
  }

  return results;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const networkTools: ToolDefinition[] = [
  // ── 1. network_traffic ────────────────────────────────────────────────────
  {
    tool: {
      name: "network_traffic",
      description:
        "Get network traffic statistics. If a package name is provided, shows per-app traffic (rx/tx bytes and packets) using kernel UID counters. Otherwise shows global per-interface totals from dumpsys netstats. Android only.",
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description:
              "App package name (e.g. com.example.app). Omit to show global interface totals.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: [],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = ctx.deviceManager.getCurrentPlatform();
      if (platform !== "android") {
        return { text: ANDROID_ONLY_MSG("network_traffic") };
      }

      const adb = ctx.deviceManager.getAndroidClient();
      const pkg = args.package as string | undefined;

      // ── Per-app mode ──
      if (pkg) {
        validatePackageName(pkg);

        // Step 1: resolve UID
        const uidRaw = adb.shell(`cmd package list packages -U ${pkg}`);
        const uid = parseUid(uidRaw);
        if (!uid) {
          return { text: `Package "${pkg}" not found on device.` };
        }

        // Step 2: read kernel traffic counters
        let statsRaw: string;
        try {
          statsRaw = adb.shell("cat /proc/net/xt_qtaguid/stats");
        } catch {
          // Fallback: newer kernels may not have xt_qtaguid
          return {
            text:
              `UID ${uid} resolved for "${pkg}", but /proc/net/xt_qtaguid/stats is unavailable on this device/kernel. ` +
              `Try network_traffic without a package to view global interface stats.`,
          };
        }

        const { rxBytes, txBytes, rxPackets, txPackets } = parseQtaguidStats(statsRaw, uid);

        if (rxBytes === 0 && txBytes === 0) {
          return {
            text:
              `Traffic stats for ${pkg} (UID ${uid}):\n` +
              `  No traffic recorded (app may not have sent/received data since last boot).`,
          };
        }

        return {
          text:
            `Traffic stats for ${pkg} (UID ${uid}):\n` +
            `  Received:      ${formatBytes(rxBytes)} (${rxPackets.toLocaleString()} packets)\n` +
            `  Transmitted:   ${formatBytes(txBytes)} (${txPackets.toLocaleString()} packets)\n` +
            `  Total:         ${formatBytes(rxBytes + txBytes)}`,
        };
      }

      // ── Global mode ──
      const raw = adb.shell("dumpsys netstats --detail");
      const ifaces = parseNetstatsGlobal(raw);

      if (ifaces.length === 0) {
        return { text: truncateOutput("No interface traffic data found in dumpsys netstats.") };
      }

      const lines = ["Global network traffic (per interface, cumulative since boot):"];
      let totalRx = 0, totalTx = 0;
      for (const iface of ifaces) {
        lines.push(
          `  ${iface.iface.padEnd(12)} ` +
          `RX: ${formatBytes(iface.rxBytes).padStart(10)} (${iface.rxPackets.toLocaleString()} pkts)  ` +
          `TX: ${formatBytes(iface.txBytes).padStart(10)} (${iface.txPackets.toLocaleString()} pkts)`,
        );
        totalRx += iface.rxBytes;
        totalTx += iface.txBytes;
      }
      lines.push(`  ${"TOTAL".padEnd(12)} RX: ${formatBytes(totalRx).padStart(10)}  TX: ${formatBytes(totalTx).padStart(10)}`);

      return { text: lines.join("\n") };
    },
  },

  // ── 2. network_connectivity ───────────────────────────────────────────────
  {
    tool: {
      name: "network_connectivity",
      description:
        "Get current network connectivity info: active network type (WiFi/Mobile/etc), connection state, IP address, DNS servers, and basic WiFi details (SSID, RSSI). Android only.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: [],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = ctx.deviceManager.getCurrentPlatform();
      if (platform !== "android") {
        return { text: ANDROID_ONLY_MSG("network_connectivity") };
      }

      const adb = ctx.deviceManager.getAndroidClient();

      // Limit dumpsys connectivity output — it can be thousands of lines
      const connRaw = adb.shell("dumpsys connectivity 2>/dev/null | head -n 80");
      const wifiRaw = adb.shell("dumpsys wifi 2>/dev/null | head -n 40");

      const lines: string[] = ["Network Connectivity:"];

      // ── Active network ──
      const activeTypeMatch = connRaw.match(/Active default network.*?:\s*(\S+)/i)
        ?? connRaw.match(/mActiveDefaultNetwork=.*?type:\s*(\S+)/i)
        ?? connRaw.match(/NetworkInfo\s*.*?type:\s*([\w/]+)/i);
      const activeType = activeTypeMatch?.[1] ?? "unknown";
      lines.push(`  Active network:  ${activeType}`);

      // ── Connection state ──
      const isConnected = /state:\s*CONNECTED/i.test(connRaw)
        || /isConnected\(\)\s*=\s*true/i.test(connRaw)
        || /connected=true/i.test(connRaw);
      lines.push(`  Connected:       ${isConnected ? "yes" : "no"}`);

      // ── IP address (IPv4 preferred) ──
      const ipv4Match = connRaw.match(/LinkAddresses:\s*\[([^\]]+)\]/i)
        ?? connRaw.match(/mLinkAddresses=\[([^\]]+)\]/i);
      const ipBlock = ipv4Match?.[1] ?? "";
      const ipv4 = ipBlock.match(/(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})/)?.[1]
        ?? connRaw.match(/\binet addr:(\d{1,3}(?:\.\d{1,3}){3})\b/i)?.[1]
        ?? "n/a";
      lines.push(`  IP address:      ${ipv4}`);

      // ── DNS ──
      const dnsMatches = [...connRaw.matchAll(/DnsAddresses:\s*\[([^\]]+)\]/gi)];
      if (dnsMatches.length > 0) {
        const dns = dnsMatches.map(m => m[1].trim()).join(", ");
        lines.push(`  DNS:             ${dns}`);
      } else {
        // Fallback: getprop
        const dns1 = adb.shell("getprop net.dns1").trim();
        const dns2 = adb.shell("getprop net.dns2").trim();
        const dnsList = [dns1, dns2].filter(Boolean).join(", ");
        lines.push(`  DNS:             ${dnsList || "n/a"}`);
      }

      // ── WiFi details ──
      const ssidMatch = wifiRaw.match(/mWifiInfo.*?SSID:\s*"?([^",\n]+)"?/i)
        ?? wifiRaw.match(/SSID:\s*"?([^",\n]+)"?/i);
      const rssiMatch = wifiRaw.match(/rssi=(-?\d+)/i)
        ?? wifiRaw.match(/RSSI:\s*(-?\d+)/i);

      if (ssidMatch?.[1] && ssidMatch[1] !== "<unknown ssid>") {
        lines.push(`  WiFi SSID:       ${ssidMatch[1].trim()}`);
      }
      if (rssiMatch?.[1]) {
        lines.push(`  WiFi RSSI:       ${rssiMatch[1]} dBm`);
      }

      // ── Mobile data ──
      const mobileType = adb.shell("getprop gsm.network.type").trim();
      if (mobileType && mobileType !== "Unknown") {
        lines.push(`  Mobile type:     ${mobileType}`);
      }

      return { text: lines.join("\n") };
    },
  },

  // ── 3. network_proxy ──────────────────────────────────────────────────────
  {
    tool: {
      name: "network_proxy",
      description:
        "Get, set, or clear the global HTTP proxy for the Android device. " +
        "GET mode (no args): show current proxy. " +
        "SET mode (host + optional port): configure proxy. " +
        "CLEAR mode (clear:true): remove proxy. Android only.",
      inputSchema: {
        type: "object",
        properties: {
          host: {
            type: "string",
            description:
              "Proxy hostname or IP (set mode). E.g. 192.168.1.100 or proxy.corp.com",
          },
          port: {
            type: "number",
            description: "Proxy port (set mode, default: 8080). Range: 1–65535.",
          },
          clear: {
            type: "boolean",
            description: "Clear the current proxy setting.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: [],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = ctx.deviceManager.getCurrentPlatform();
      if (platform !== "android") {
        return { text: ANDROID_ONLY_MSG("network_proxy") };
      }

      const adb = ctx.deviceManager.getAndroidClient();
      const host  = args.host  as string  | undefined;
      const port  = args.port  as number  | undefined;
      const clear = args.clear as boolean | undefined;

      // ── CLEAR mode ──
      if (clear) {
        adb.shell("settings put global http_proxy :0");
        return { text: "HTTP proxy cleared." };
      }

      // ── SET mode ──
      if (host !== undefined) {
        if (!HOST_RE.test(host)) {
          throw new ValidationError(
            `Invalid proxy host: "${host}". Only alphanumeric characters, dots, and hyphens are allowed.`,
          );
        }
        const resolvedPort = port ?? 8080;
        if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
          throw new ValidationError(
            `Invalid proxy port: ${resolvedPort}. Must be an integer between 1 and 65535.`,
          );
        }
        adb.shell(`settings put global http_proxy ${host}:${resolvedPort}`);
        // Verify the write was accepted
        const current = adb.shell("settings get global http_proxy").trim();
        return { text: `HTTP proxy set to ${host}:${resolvedPort}\nVerified setting: ${current}` };
      }

      // ── GET mode ──
      const current = adb.shell("settings get global http_proxy").trim();
      if (!current || current === "null" || current === ":0") {
        return { text: "HTTP proxy: not configured" };
      }
      return { text: `HTTP proxy: ${current}` };
    },
  },

  // ── 4. network_airplane ───────────────────────────────────────────────────
  {
    tool: {
      name: "network_airplane",
      description:
        "Enable or disable airplane mode on the Android device. " +
        "Broadcasts the mode change intent so the OS applies it immediately. Android only.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "true to enable airplane mode, false to disable it.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["enabled"],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = ctx.deviceManager.getCurrentPlatform();
      if (platform !== "android") {
        return { text: ANDROID_ONLY_MSG("network_airplane") };
      }

      const enabled = args.enabled as boolean;
      if (typeof enabled !== "boolean") {
        throw new ValidationError("enabled must be a boolean (true or false).");
      }

      const adb = ctx.deviceManager.getAndroidClient();
      const value = enabled ? "1" : "0";

      // Write the setting
      adb.shell(`settings put global airplane_mode_on ${value}`);
      // Broadcast so the framework reacts immediately
      adb.shell("am broadcast -a android.intent.action.AIRPLANE_MODE");

      const state = enabled ? "ENABLED" : "DISABLED";
      return { text: `Airplane mode ${state}.` };
    },
  },
];
