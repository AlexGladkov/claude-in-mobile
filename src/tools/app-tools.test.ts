import { describe, it, expect, vi } from "vitest";
import { appTools } from "./app-tools.js";
import { MobileError } from "../errors.js";
import type { ToolContext } from "./context.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function findHandler(name: string) {
  const def = appTools.find(t => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in appTools`);
  return def.handler;
}

function makeMockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    deviceManager: {
      launchApp: vi.fn(() => "launched"),
      stopApp: vi.fn(),
      installApp: vi.fn(() => "installed"),
      getCurrentPlatform: vi.fn(() => "android"),
      getAuroraClient: vi.fn(() => ({ listPackages: vi.fn(() => []) })),
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
// app_launch — security validation
// ──────────────────────────────────────────────

describe("app_launch", () => {
  const handler = findHandler("app_launch");

  it("throws INVALID_PACKAGE_NAME for package with semicolon injection", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "com.example;rm" }, ctx)).rejects.toThrow(MobileError);
    try {
      await handler({ package: "com.example;rm" }, ctx);
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_PACKAGE_NAME");
    }
  });

  it("throws INVALID_PACKAGE_NAME for package with pipe injection", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "com.example|cat" }, ctx)).rejects.toThrow(MobileError);
  });

  it("throws INVALID_PACKAGE_NAME for empty package name", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "" }, ctx)).rejects.toThrow(MobileError);
  });

  it("throws INVALID_PACKAGE_NAME for package with $() injection", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "com.$(whoami).app" }, ctx)).rejects.toThrow(MobileError);
  });

  it("accepts valid package name", async () => {
    const ctx = makeMockContext();
    const result = await handler({ package: "com.android.settings" }, ctx);
    expect(result).toEqual({ text: "launched" });
  });
});

// ──────────────────────────────────────────────
// app_stop — security validation
// ──────────────────────────────────────────────

describe("app_stop", () => {
  const handler = findHandler("app_stop");

  it("throws INVALID_PACKAGE_NAME for package with semicolon injection", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "com.example;rm" }, ctx)).rejects.toThrow(MobileError);
    try {
      await handler({ package: "com.example;rm" }, ctx);
    } catch (e) {
      expect((e as MobileError).code).toBe("INVALID_PACKAGE_NAME");
    }
  });

  it("throws INVALID_PACKAGE_NAME for package with spaces", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "com.example app" }, ctx)).rejects.toThrow(MobileError);
  });

  it("accepts valid package name", async () => {
    const ctx = makeMockContext();
    const result = await handler({ package: "com.android.settings" }, ctx);
    expect(result).toEqual({ text: "Stopped: com.android.settings" });
  });
});

// ──────────────────────────────────────────────
// app_install — path traversal prevention
// ──────────────────────────────────────────────

describe("app_install", () => {
  const handler = findHandler("app_install");

  it("throws PATH_TRAVERSAL_BLOCKED for path with ..", async () => {
    const ctx = makeMockContext();
    await expect(handler({ path: "../../etc/passwd" }, ctx)).rejects.toThrow(MobileError);
    try {
      await handler({ path: "../../etc/passwd" }, ctx);
    } catch (e) {
      expect((e as MobileError).code).toBe("PATH_TRAVERSAL_BLOCKED");
    }
  });

  it("throws PATH_TRAVERSAL_BLOCKED for path traversal in middle", async () => {
    const ctx = makeMockContext();
    await expect(handler({ path: "/sdcard/../etc/passwd" }, ctx)).rejects.toThrow(MobileError);
  });

  it("accepts valid APK path", async () => {
    const ctx = makeMockContext();
    const result = await handler({ path: "/sdcard/downloads/app.apk" }, ctx);
    expect(result).toEqual({ text: "installed" });
  });
});
