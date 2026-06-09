/**
 * Network tools for Android devices.
 */

import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { deviceIdField } from "./common-schema.js";
import { ValidationError } from "../errors.js";
import { truncateOutput } from "../utils/truncate.js";
import { validatePackageName } from "../utils/sanitize.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ANDROID_ONLY_MSG = (tool: string) =>
  `${tool} is only available for Android.`;

/** Hostname validation: alphanumeric, dots, hyphens; must start with alphanumeric. */
const HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9.\-]*$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function parseUid(output: string): string | null {
  const match = output.match(/uid:(\d+)/);
  return match ? match[1] : null;
}

function parseQtaguidStats(raw: string, uid: string): {
  rxBytes: number;
  txBytes: number;
  rxPackets: number;
  txPackets: number;
} {
  let rxBytes = 0, txBytes = 0, rxPackets = 0, txPackets = 0;
  for (const line of raw.split("\n")) {
    const cols = line.trim().split(/\s+/);
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

    if (rxBytes === 0 && txBytes === 0 && rxPackets === 0 && txPackets === 0) continue;

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
  defineTool({
    name: "network_traffic",
    description:
      "Get network traffic statistics. If a package name is provided, shows per-app traffic (rx/tx bytes and packets) using kernel UID counters. Otherwise shows global per-interface totals from dumpsys netstats. Android only.",
    schema: z.object({
      package: z
        .string()
        .optional()
        .describe("App package name (e.g. com.example.app). Omit to show global interface totals."),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return textResult(ANDROID_ONLY_MSG("network_traffic"));
      }

      const pkg = args.package;

      if (pkg) {
        validatePackageName(pkg);

        const uidRaw = ctx.deviceManager.shell(`cmd package list packages -U ${pkg}`, "android", deviceId);
        const uid = parseUid(uidRaw);
        if (!uid) {
          return textResult(`Package "${pkg}" not found on device.`);
        }

        let statsRaw: string;
        try {
          statsRaw = ctx.deviceManager.shell("cat /proc/net/xt_qtaguid/stats", "android", deviceId);
        } catch {
          return textResult(
            `UID ${uid} resolved for "${pkg}", but /proc/net/xt_qtaguid/stats is unavailable on this device/kernel. ` +
            `Try network_traffic without a package to view global interface stats.`,
          );
        }

        const { rxBytes, txBytes, rxPackets, txPackets } = parseQtaguidStats(statsRaw, uid);

        if (rxBytes === 0 && txBytes === 0) {
          return textResult(
            `Traffic stats for ${pkg} (UID ${uid}):\n` +
            `  No traffic recorded (app may not have sent/received data since last boot).`,
          );
        }

        return textResult(
          `Traffic stats for ${pkg} (UID ${uid}):\n` +
          `  Received:      ${formatBytes(rxBytes)} (${rxPackets.toLocaleString()} packets)\n` +
          `  Transmitted:   ${formatBytes(txBytes)} (${txPackets.toLocaleString()} packets)\n` +
          `  Total:         ${formatBytes(rxBytes + txBytes)}`,
        );
      }

      const raw = ctx.deviceManager.shell("dumpsys netstats --detail", "android", deviceId);
      const ifaces = parseNetstatsGlobal(raw);

      if (ifaces.length === 0) {
        return textResult(truncateOutput("No interface traffic data found in dumpsys netstats."));
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

      return textResult(lines.join("\n"));
    },
  }),

  defineTool({
    name: "network_connectivity",
    description:
      "Get current network connectivity info: active network type (WiFi/Mobile/etc), connection state, IP address, DNS servers, and basic WiFi details (SSID, RSSI). Android only.",
    schema: z.object({
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return textResult(ANDROID_ONLY_MSG("network_connectivity"));
      }

      const connRaw = ctx.deviceManager.shell("dumpsys connectivity 2>/dev/null | head -n 80", "android", deviceId);
      const wifiRaw = ctx.deviceManager.shell("dumpsys wifi 2>/dev/null | head -n 40", "android", deviceId);

      const lines: string[] = ["Network Connectivity:"];

      const activeTypeMatch = connRaw.match(/Active default network.*?:\s*(\S+)/i)
        ?? connRaw.match(/mActiveDefaultNetwork=.*?type:\s*(\S+)/i)
        ?? connRaw.match(/NetworkInfo\s*.*?type:\s*([\w/]+)/i);
      const activeType = activeTypeMatch?.[1] ?? "unknown";
      lines.push(`  Active network:  ${activeType}`);

      const isConnected = /state:\s*CONNECTED/i.test(connRaw)
        || /isConnected\(\)\s*=\s*true/i.test(connRaw)
        || /connected=true/i.test(connRaw);
      lines.push(`  Connected:       ${isConnected ? "yes" : "no"}`);

      const ipv4Match = connRaw.match(/LinkAddresses:\s*\[([^\]]+)\]/i)
        ?? connRaw.match(/mLinkAddresses=\[([^\]]+)\]/i);
      const ipBlock = ipv4Match?.[1] ?? "";
      const ipv4 = ipBlock.match(/(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})/)?.[1]
        ?? connRaw.match(/\binet addr:(\d{1,3}(?:\.\d{1,3}){3})\b/i)?.[1]
        ?? "n/a";
      lines.push(`  IP address:      ${ipv4}`);

      const dnsMatches = [...connRaw.matchAll(/DnsAddresses:\s*\[([^\]]+)\]/gi)];
      if (dnsMatches.length > 0) {
        const dns = dnsMatches.map(m => m[1].trim()).join(", ");
        lines.push(`  DNS:             ${dns}`);
      } else {
        const dns1 = ctx.deviceManager.shell("getprop net.dns1", "android", deviceId).trim();
        const dns2 = ctx.deviceManager.shell("getprop net.dns2", "android", deviceId).trim();
        const dnsList = [dns1, dns2].filter(Boolean).join(", ");
        lines.push(`  DNS:             ${dnsList || "n/a"}`);
      }

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

      const mobileType = ctx.deviceManager.shell("getprop gsm.network.type", "android", deviceId).trim();
      if (mobileType && mobileType !== "Unknown") {
        lines.push(`  Mobile type:     ${mobileType}`);
      }

      return textResult(lines.join("\n"));
    },
  }),

  defineTool({
    name: "network_proxy",
    description:
      "Get, set, or clear the global HTTP proxy for the Android device. " +
      "GET mode (no args): show current proxy. " +
      "SET mode (host + optional port): configure proxy. " +
      "CLEAR mode (clear:true): remove proxy. Android only.",
    schema: z.object({
      host: z
        .string()
        .optional()
        .describe(
          "Proxy hostname or IP (set mode). E.g. 192.168.1.100 or proxy.corp.com",
        ),
      port: z
        .number()
        .optional()
        .describe("Proxy port (set mode, default: 8080). Range: 1–65535."),
      clear: z.boolean().optional().describe("Clear the current proxy setting."),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return textResult(ANDROID_ONLY_MSG("network_proxy"));
      }

      const host = args.host;
      const port = args.port;
      const clear = args.clear;

      if (clear) {
        ctx.deviceManager.shell("settings put global http_proxy :0", "android", deviceId);
        return textResult("HTTP proxy cleared.");
      }

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
        ctx.deviceManager.shell(`settings put global http_proxy ${host}:${resolvedPort}`, "android", deviceId);
        const current = ctx.deviceManager.shell("settings get global http_proxy", "android", deviceId).trim();
        return textResult(`HTTP proxy set to ${host}:${resolvedPort}\nVerified setting: ${current}`);
      }

      const current = ctx.deviceManager.shell("settings get global http_proxy", "android", deviceId).trim();
      if (!current || current === "null" || current === ":0") {
        return textResult("HTTP proxy: not configured");
      }
      return textResult(`HTTP proxy: ${current}`);
    },
  }),

  defineTool({
    name: "network_airplane",
    description:
      "Enable or disable airplane mode on the Android device. " +
      "Broadcasts the mode change intent so the OS applies it immediately. Android only.",
    schema: z.object({
      enabled: z.unknown().describe("true to enable airplane mode, false to disable it."),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "android") {
        return textResult(ANDROID_ONLY_MSG("network_airplane"));
      }

      const enabled = args.enabled;
      if (typeof enabled !== "boolean") {
        throw new ValidationError("enabled must be a boolean (true or false).");
      }

      const value = enabled ? "1" : "0";

      ctx.deviceManager.shell(`settings put global airplane_mode_on ${value}`, "android", deviceId);
      ctx.deviceManager.shell("am broadcast -a android.intent.action.AIRPLANE_MODE", "android", deviceId);

      const state = enabled ? "ENABLED" : "DISABLED";
      return textResult(`Airplane mode ${state}.`);
    },
  }),
];
