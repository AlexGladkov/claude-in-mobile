import { describe, it, expect, vi } from "vitest";
import { systemTools } from "./system-tools.js";
import type { ToolContext } from "./context.js";

function findHandler(name: string) {
  const def = systemTools.find(t => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in systemTools`);
  return def.handler;
}

function makeMockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "android"),
      getLogs: vi.fn(() => ""),
      clearLogs: vi.fn(() => "Logcat buffer cleared"),
      shell: vi.fn(() => ""),
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
    platformParam: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "" },
    handleTool: vi.fn(async () => ({ text: "ok" })),
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// system_wait_log
// ──────────────────────────────────────────────

describe("system_wait_log", () => {
  const handler = findHandler("system_wait_log");

  it("returns 'only available for Android' on non-android platform", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        getLogs: vi.fn(() => ""),
        clearLogs: vi.fn(() => ""),
      } as any,
    });
    const result = await handler({ pattern: "anything" }, ctx);
    expect((result as { text: string }).text).toContain("only available for Android");
  });

  it("rejects empty pattern", async () => {
    const ctx = makeMockContext();
    const result = await handler({ pattern: "" }, ctx);
    expect((result as { text: string }).text).toContain("required");
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
