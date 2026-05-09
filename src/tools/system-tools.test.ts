import { describe, it, expect, vi } from "vitest";
import { systemTools } from "./system-tools.js";
import { MobileError } from "../errors.js";
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
    expect(shell).toHaveBeenCalledWith("pidof -s com.example.app", undefined);
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
