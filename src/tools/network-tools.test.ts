import { describe, it, expect, vi } from "vitest";
import { networkTools } from "./network-tools.js";
import { ValidationError } from "../errors.js";
import type { ToolContext } from "./context.js";

function findHandler(name: string) {
  const def = networkTools.find(t => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found`);
  return def.handler;
}

function makeMockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "android"),
      getAndroidClient: vi.fn(() => ({
        shell: vi.fn(() => ""),
        exec: vi.fn(() => ""),
      })),
    } as any,
    getCachedElements: vi.fn(() => []),
    setCachedElements: vi.fn(),
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: vi.fn(async () => ""),
    getElementsForPlatform: vi.fn(async () => []),
    iosTreeToUiElements: vi.fn(() => []),
    formatIOSUITree: vi.fn(() => ""),
    platformParam: { type: "string", enum: ["android", "ios", "desktop"], description: "" },
    handleTool: vi.fn(async () => ({ text: "ok" })),
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// network_traffic
// ──────────────────────────────────────────────

describe("network_traffic", () => {
  const handler = findHandler("network_traffic");

  it("returns android-only message on non-android platform", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        getAndroidClient: vi.fn(),
      } as any,
    });
    const result = await handler({}, ctx);
    expect((result as { text: string }).text).toContain("only available for Android");
  });

  it("global mode: parses netstats output and formats bytes correctly", async () => {
    const mockOutput =
      "iface=wlan0 rxBytes=1048576 rxPackets=500 txBytes=524288 txPackets=250\n" +
      "iface=rmnet0 rxBytes=2097152 rxPackets=1000 txBytes=1048576 txPackets=500";
    const shell = vi.fn().mockReturnValue(mockOutput);
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({}, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("wlan0");
    expect(text).toContain("rmnet0");
    expect(text).toContain("1.0 MB");
    expect(text).toContain("512.0 KB");
    expect(text).toContain("2.0 MB");
    expect(text).toContain("500");
    expect(shell).toHaveBeenCalledWith("dumpsys netstats --detail", "android", undefined);
  });

  it("global mode: aggregates same-interface entries and shows TOTAL line", async () => {
    const mockOutput =
      "iface=wlan0 rxBytes=524288 rxPackets=200 txBytes=262144 txPackets=100\n" +
      "iface=wlan0 rxBytes=524288 rxPackets=300 txBytes=262144 txPackets=150";
    const shell = vi.fn().mockReturnValue(mockOutput);
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({}, ctx);
    const text = (result as { text: string }).text;
    // wlan0 should appear once aggregated (1 MB rx total)
    expect(text).toContain("wlan0");
    expect(text).toContain("TOTAL");
    // aggregated rx = 524288 + 524288 = 1048576 bytes = 1.0 MB
    expect(text).toContain("1.0 MB");
  });

  it("global mode: skips all-zero rows and returns message when no data found", async () => {
    const mockOutput =
      "iface=lo rxBytes=0 rxPackets=0 txBytes=0 txPackets=0\n" +
      "some other dumpsys line without iface prefix";
    const shell = vi.fn().mockReturnValue(mockOutput);
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({}, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("No interface traffic data found");
  });

  it("per-app mode: resolves UID and reads qtaguid stats", async () => {
    const shell = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("list packages")) {
        return "package:com.test.app uid:10123\n";
      }
      if (cmd.includes("xt_qtaguid")) {
        return [
          "idx iface acct_tag_hex uid_tag_int cnt_set rx_bytes rx_packets tx_bytes tx_packets",
          "0 wlan0 0x0 10123 0 524288 100 262144 50",
          "1 wlan0 0x0 10124 0 1000 10 500 5",
        ].join("\n");
      }
      return "";
    });
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({ package: "com.test.app" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("com.test.app");
    expect(text).toContain("10123");
    // Should contain rx/tx for UID 10123 only (512 KB rx, 256 KB tx)
    expect(text).toContain("512.0 KB");
    expect(text).toContain("256.0 KB");
    expect(text).toContain("Received");
    expect(text).toContain("Transmitted");
  });

  it("per-app mode: only counts traffic for the resolved UID, ignores other UIDs", async () => {
    const shell = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("list packages")) {
        return "package:com.test.app uid:10123\n";
      }
      if (cmd.includes("xt_qtaguid")) {
        return [
          "0 wlan0 0x0 10123 0 1024 10 2048 20",
          "1 wlan0 0x0 99999 0 999999 900 999999 900",
        ].join("\n");
      }
      return "";
    });
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({ package: "com.test.app" }, ctx);
    const text = (result as { text: string }).text;
    // Only UID 10123: 1024 rx = 1.0 KB, 2048 tx = 2.0 KB
    expect(text).toContain("1.0 KB");
    expect(text).toContain("2.0 KB");
    // UID 99999's large traffic must not appear
    expect(text).not.toContain("999999");
  });

  it("per-app mode: returns package-not-found when UID cannot be resolved", async () => {
    const shell = vi.fn().mockReturnValue(""); // empty output — no UID
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({ package: "com.ghost.app" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("com.ghost.app");
    expect(text).toContain("not found");
  });

  it("per-app mode: validates package name and throws on invalid format", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "bad package name!" }, ctx)).rejects.toThrow();
  });

  it("per-app mode: handles xt_qtaguid unavailable (shell throws)", async () => {
    const shell = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("list packages")) {
        return "package:com.test.app uid:10123\n";
      }
      throw new Error("No such file or directory");
    });
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({ package: "com.test.app" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("unavailable");
    expect(text).toContain("10123");
  });

  it("per-app mode: returns no-traffic message when rxBytes and txBytes are both 0", async () => {
    const shell = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("list packages")) {
        return "package:com.idle.app uid:10200\n";
      }
      if (cmd.includes("xt_qtaguid")) {
        // UID 10200 present but with zero traffic
        return "0 wlan0 0x0 10200 0 0 0 0 0\n";
      }
      return "";
    });
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({ package: "com.idle.app" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("No traffic recorded");
  });
});

// ──────────────────────────────────────────────
// network_connectivity
// ──────────────────────────────────────────────

describe("network_connectivity", () => {
  const handler = findHandler("network_connectivity");

  it("returns android-only message on non-android platform", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        getAndroidClient: vi.fn(),
      } as any,
    });
    const result = await handler({}, ctx);
    expect((result as { text: string }).text).toContain("only available for Android");
  });

  it("parses active network type, connection state, IP, and DNS from dumpsys output", async () => {
    // The implementation regex `/Active default network.*?:\s*(\S+)/i` captures the token after
    // the LAST colon in the line. Use `mActiveDefaultNetwork=...type: WIFI` format which is matched
    // by the second pattern `/mActiveDefaultNetwork=.*?type:\s*(\S+)/i`.
    const connRaw = [
      "  mActiveDefaultNetwork=100 type: WIFI",
      "  state: CONNECTED",
      "  LinkAddresses: [192.168.1.100/24]",
      "  DnsAddresses: [8.8.8.8, 8.8.4.4]",
    ].join("\n");
    const wifiRaw = [
      'SSID: "MyNetwork"',
      "rssi=-42",
    ].join("\n");

    const shell = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("connectivity")) return connRaw;
      if (cmd.includes("wifi")) return wifiRaw;
      return "";
    });
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({}, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("WIFI");
    expect(text).toContain("192.168.1.100/24");
    expect(text).toContain("8.8.8.8");
    expect(text).toContain("8.8.4.4");
    expect(text).toContain("MyNetwork");
    expect(text).toContain("-42");
  });

  it("detects connected state correctly", async () => {
    const connRaw = "some info\n  state: CONNECTED\nmore info";
    const shell = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("connectivity")) return connRaw;
      return "";
    });
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({}, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("Connected:       yes");
  });

  it("falls back to getprop for DNS when DnsAddresses not present in dumpsys", async () => {
    const connRaw = "Active default network: type: MOBILE\n  state: CONNECTED";
    const shell = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("connectivity")) return connRaw;
      if (cmd.includes("wifi")) return "";
      if (cmd.includes("net.dns1")) return "1.1.1.1\n";
      if (cmd.includes("net.dns2")) return "1.0.0.1\n";
      if (cmd.includes("gsm.network.type")) return "LTE\n";
      return "";
    });
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({}, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("1.1.1.1");
    expect(text).toContain("1.0.0.1");
  });

  it("shows mobile network type from getprop gsm.network.type", async () => {
    const connRaw = "NetworkInfo type: MOBILE\n  state: CONNECTED";
    const shell = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("connectivity")) return connRaw;
      if (cmd.includes("wifi")) return "";
      if (cmd.includes("gsm.network.type")) return "LTE\n";
      return "";
    });
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({}, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("LTE");
    expect(text).toContain("Mobile type");
  });
});

// ──────────────────────────────────────────────
// network_proxy
// ──────────────────────────────────────────────

describe("network_proxy", () => {
  const handler = findHandler("network_proxy");

  it("returns android-only message on non-android platform", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "desktop"),
        getAndroidClient: vi.fn(),
      } as any,
    });
    const result = await handler({}, ctx);
    expect((result as { text: string }).text).toContain("only available for Android");
  });

  it("GET mode: returns current proxy from settings", async () => {
    const shell = vi.fn().mockReturnValue("192.168.1.200:8888");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({}, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("192.168.1.200:8888");
    expect(shell).toHaveBeenCalledWith("settings get global http_proxy", "android", undefined);
  });

  it("GET mode: returns not-configured when proxy is null", async () => {
    const shell = vi.fn().mockReturnValue("null");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({}, ctx);
    expect((result as { text: string }).text).toContain("not configured");
  });

  it("GET mode: returns not-configured when proxy is :0", async () => {
    const shell = vi.fn().mockReturnValue(":0");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({}, ctx);
    expect((result as { text: string }).text).toContain("not configured");
  });

  it("SET mode: sets proxy with host and explicit port", async () => {
    const shell = vi.fn().mockReturnValue("proxy.corp.com:3128");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({ host: "proxy.corp.com", port: 3128 }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("proxy.corp.com:3128");
    expect(shell).toHaveBeenCalledWith("settings put global http_proxy proxy.corp.com:3128", "android", undefined);
  });

  it("SET mode: defaults port to 8080 when port is not specified", async () => {
    const shell = vi.fn().mockReturnValue("192.168.1.100:8080");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({ host: "192.168.1.100" }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("8080");
    expect(shell).toHaveBeenCalledWith("settings put global http_proxy 192.168.1.100:8080", "android", undefined);
  });

  it("SET mode: throws ValidationError for invalid hostname with semicolon", async () => {
    const ctx = makeMockContext();
    await expect(handler({ host: "bad;host" }, ctx)).rejects.toThrow(ValidationError);
  });

  it("SET mode: throws ValidationError for invalid hostname starting with dot", async () => {
    const ctx = makeMockContext();
    await expect(handler({ host: ".invalid.host" }, ctx)).rejects.toThrow(ValidationError);
  });

  it("SET mode: throws ValidationError for port 0", async () => {
    const ctx = makeMockContext();
    await expect(handler({ host: "valid.host.com", port: 0 }, ctx)).rejects.toThrow(ValidationError);
  });

  it("SET mode: throws ValidationError for port 65536", async () => {
    const ctx = makeMockContext();
    await expect(handler({ host: "valid.host.com", port: 65536 }, ctx)).rejects.toThrow(ValidationError);
  });

  it("SET mode: throws ValidationError for negative port", async () => {
    const ctx = makeMockContext();
    await expect(handler({ host: "valid.host.com", port: -1 }, ctx)).rejects.toThrow(ValidationError);
  });

  it("CLEAR mode: writes :0 to clear proxy", async () => {
    const shell = vi.fn().mockReturnValue("");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({ clear: true }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("cleared");
    expect(shell).toHaveBeenCalledWith("settings put global http_proxy :0", "android", undefined);
  });
});

// ──────────────────────────────────────────────
// network_airplane
// ──────────────────────────────────────────────

describe("network_airplane", () => {
  const handler = findHandler("network_airplane");

  it("returns android-only message on non-android platform", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        getAndroidClient: vi.fn(),
      } as any,
    });
    const result = await handler({ enabled: true }, ctx);
    expect((result as { text: string }).text).toContain("only available for Android");
  });

  it("enables airplane mode: calls shell with value=1 and broadcasts intent", async () => {
    const shell = vi.fn().mockReturnValue("");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({ enabled: true }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("ENABLED");
    expect(shell).toHaveBeenCalledWith("settings put global airplane_mode_on 1", "android", undefined);
    expect(shell).toHaveBeenCalledWith("am broadcast -a android.intent.action.AIRPLANE_MODE", "android", undefined);
  });

  it("disables airplane mode: calls shell with value=0 and broadcasts intent", async () => {
    const shell = vi.fn().mockReturnValue("");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        shell,
      } as any,
    });
    const result = await handler({ enabled: false }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("DISABLED");
    expect(shell).toHaveBeenCalledWith("settings put global airplane_mode_on 0", "android", undefined);
    expect(shell).toHaveBeenCalledWith("am broadcast -a android.intent.action.AIRPLANE_MODE", "android", undefined);
  });

  it("throws ValidationError when enabled is not a boolean", async () => {
    const ctx = makeMockContext();
    await expect(handler({ enabled: "yes" as unknown as boolean }, ctx)).rejects.toThrow(ValidationError);
  });
});
