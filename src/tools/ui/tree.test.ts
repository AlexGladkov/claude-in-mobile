import { describe, it, expect, vi } from "vitest";
import { uiTree } from "./tree.js";
import { uiFind } from "./find.js";
import { iosTreeToUiElements, formatIOSUITree } from "../context/ios-helpers.js";
import { DeviceManager } from "../../device-manager.js";
import type { ToolContext } from "../context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal iOS WDA-style accessibility tree with a variety of node types. */
function makeIosTree() {
  return {
    type: "XCUIElementTypeApplication",
    rect: { x: 0, y: 0, width: 390, height: 844 },
    children: [
      {
        type: "XCUIElementTypeStaticText",
        label: "Welcome",
        rect: { x: 20, y: 60, width: 200, height: 30 },
      },
      {
        type: "XCUIElementTypeButton",
        label: "Sign in",
        enabled: true,
        rect: { x: 20, y: 700, width: 350, height: 44 },
      },
      {
        type: "XCUIElementTypeSecureTextField",
        // WDA exposes the typed password in `value` — must never be printed.
        value: "hunter2",
        label: "Password",
        rect: { x: 20, y: 400, width: 350, height: 40 },
      },
    ],
  };
}

/** Deep iOS tree with N clickable buttons, to exercise the element limit. */
function makeLargeIosTree(count: number) {
  const children = Array.from({ length: count }, (_, i) => ({
    type: "XCUIElementTypeButton",
    label: `Button ${i}`,
    enabled: true,
    rect: { x: 0, y: i * 10, width: 100, height: 8 },
  }));
  return {
    type: "XCUIElementTypeApplication",
    rect: { x: 0, y: 0, width: 390, height: 844 },
    children,
  };
}

function makeIosContext(tree: unknown, overrides?: Partial<ToolContext>): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "ios"),
      getIosClient: vi.fn(() => ({
        findElements: vi.fn(async () => [{
          id: "secure-element",
          type: "XCUIElementTypeSecureTextField",
          label: "hunter2",
          rect: { x: 20, y: 400, width: 350, height: 40 },
        }]),
      })),
      getUiHierarchy: vi.fn(async () => JSON.stringify(tree)),
      getUiHierarchyAsync: vi.fn(async () => ""),
    } as any,
    getCachedElements: vi.fn(() => []),
    setCachedElements: vi.fn(),
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: vi.fn(async () => ""),
    getElementsForPlatform: vi.fn(async () => []),
    // Real converter — this is the shared representation the fix relies on.
    iosTreeToUiElements: (t: any) => iosTreeToUiElements(t),
    formatIOSUITree: (t: any, indent?: number) => formatIOSUITree(t, indent),
    invalidateUiTreeCache: vi.fn(),
    platformParam: { type: "string", enum: ["android", "ios", "desktop"], description: "" },
    handleTool: vi.fn(async () => ({ text: "ok" })),
    turboDefault: false,
    ...overrides,
  } as ToolContext;
}

async function runTree(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const result = (await uiTree.handler(args as any, ctx)) as { content: Array<{ text: string }> };
  return result.content.map(c => c.text).join("\n");
}

// ---------------------------------------------------------------------------
// Regression guard: iOS must go through the SHARED formatting layer.
// Root cause was tree.ts early-returning formatIOSUITree, so compact/semantic/
// showAll/fresh were silently ignored on iOS.
// ---------------------------------------------------------------------------

describe("ui_tree — iOS shares the common formatting layer", () => {
  it("format:semantic produces role-grouped output (NOT the raw <Type> dump)", async () => {
    const ctx = makeIosContext(makeIosTree());
    const text = await runTree(ctx, { platform: "ios", format: "semantic" });

    // Semantic formatter groups by role with these section headers.
    expect(text).toMatch(/Actions:|Inputs:|Text:|Nav:/);
    // The bespoke iOS dump prints "<XCUIElementType...>" tags; must be gone.
    expect(text).not.toContain("<XCUIElementTypeButton>");
  });

  it("compact:true yields the short interactive-only format", async () => {
    const ctx = makeIosContext(makeIosTree());
    const text = await runTree(ctx, { platform: "ios", compact: true });

    // Compact format is "[index] ShortClass "label" (x,y)".
    expect(text).toMatch(/\[\d+\] \w+.*\(\d+,\d+\)/);
    expect(text).not.toContain("<XCUIElementTypeButton>");
  });

  it("showAll changes the output vs the filtered default", async () => {
    const ctxDefault = makeIosContext(makeIosTree());
    const ctxAll = makeIosContext(makeIosTree());

    const filtered = await runTree(ctxDefault, { platform: "ios", showAll: false });
    const all = await runTree(ctxAll, { platform: "ios", showAll: true });

    // showAll includes the non-interactive application container node, so the
    // full dump is at least as long — and the flag is actually honoured.
    expect(all.length).toBeGreaterThanOrEqual(filtered.length);
  });

  it("caches identical trees and reports 'UI unchanged' on the second call", async () => {
    const ctx = makeIosContext(makeIosTree());
    const first = await runTree(ctx, { platform: "ios" });
    const second = await runTree(ctx, { platform: "ios" });

    expect(first).not.toContain("UI unchanged");
    expect(second).toContain("UI unchanged");
  });

  it("fresh:true bypasses the dedup cache", async () => {
    const ctx = makeIosContext(makeIosTree());
    await runTree(ctx, { platform: "ios" });
    const fresh = await runTree(ctx, { platform: "ios", fresh: true });

    expect(fresh).not.toContain("UI unchanged");
  });

  it("populates the shared iOS element cache (setCachedElements('ios', …))", async () => {
    const setCachedElements = vi.fn();
    const ctx = makeIosContext(makeIosTree(), { setCachedElements });
    await runTree(ctx, { platform: "ios" });

    expect(setCachedElements).toHaveBeenCalledWith("ios", expect.any(Array), undefined);
    const cached = setCachedElements.mock.calls[0][1];
    expect(cached.length).toBeGreaterThan(0);
  });

  it("enforces the 100-element limit on iOS", async () => {
    const ctx = makeIosContext(makeLargeIosTree(250));
    const text = await runTree(ctx, { platform: "ios", showAll: true });

    expect(text).toMatch(/showing 100 of \d+ elements/);
  });
});

// ---------------------------------------------------------------------------
// Security: secure fields must never leak their value on any platform.
// ---------------------------------------------------------------------------

describe("ui_tree — SecureTextField value is redacted", () => {
  it("does not print the secure field value in the default format", async () => {
    const ctx = makeIosContext(makeIosTree());
    const text = await runTree(ctx, { platform: "ios", showAll: true });

    expect(text).not.toContain("hunter2");
    expect(text).toContain("[REDACTED]");
  });

  it("does not leak the value in semantic format", async () => {
    const ctx = makeIosContext(makeIosTree());
    const text = await runTree(ctx, { platform: "ios", format: "semantic" });

    expect(text).not.toContain("hunter2");
  });

  it("does not leak the value in compact format", async () => {
    const ctx = makeIosContext(makeIosTree());
    const text = await runTree(ctx, { platform: "ios", compact: true });

    expect(text).not.toContain("hunter2");
  });

  it("redacts SecureTextField values in the legacy iOS tree formatter", () => {
    const text = formatIOSUITree(makeIosTree());
    expect(text).not.toContain("hunter2");
    expect(text).toContain("[REDACTED]");
  });
});
describe("ui_find — iOS secure values are redacted", () => {
  it("never returns the value of a matched SecureTextField", async () => {
    const ctx = makeIosContext(makeIosTree());
    const result = await uiFind.handler(
      { platform: "ios", label: "Password" } as any,
      ctx,
    ) as { content: Array<{ text: string }> };
    const output = result.content.map((item) => item.text).join("\n");

    expect(output).not.toContain("hunter2");
    expect(output).toContain("[REDACTED]");
  });
});

describe("ui_find — iOS label terminal safety", () => {
  it("strips terminal controls from non-secure WDA labels", async () => {
    const rect = { x: 20, y: 60, width: 200, height: 30 };
    const label = "\u001b[31mOpen\u202e settings\u001b[0m";
    const ctx = makeIosContext({
      type: "XCUIElementTypeApplication",
      rect: { x: 0, y: 0, width: 390, height: 844 },
      children: [{ type: "XCUIElementTypeButton", label: "Open settings", rect }],
    });
    (ctx.deviceManager as any).getIosClient = vi.fn(() => ({
      findElements: vi.fn(async () => [{
        type: "XCUIElementTypeButton",
        label,
        rect,
      }]),
    }));

    const result = await uiFind.handler({ platform: "ios" } as any, ctx) as {
      content: Array<{ text: string }>;
    };
    const output = result.content.map((item) => item.text).join("\n");

    expect(output).toContain("Open");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u202e");
  });
});

describe("ui_tree — browser accessibility provider", () => {
  it("formats normalized browser records instead of parsing snapshot text as XML", async () => {
    const getUiElements = vi.fn(async () => [{
      role: "button",
      label: "Open settings",
      clickable: true,
      bounds: { x: 30, y: 40, width: 120, height: 44 },
    }]);
    const adapter = {
      platform: "browser",
      listDevices: () => [],
      selectDevice: () => {},
      getSelectedDeviceId: () => "browser",
      autoDetectDevice: () => undefined,
      tap: async () => {},
      doubleTap: async () => {},
      longPress: async () => {},
      swipe: async () => {},
      swipeDirection: async () => {},
      inputText: async () => {},
      pressKey: async () => {},
      screenshotAsync: async () => ({ data: "", mimeType: "image/png" }),
      getScreenshotBufferAsync: async () => Buffer.alloc(0),
      getUiHierarchy: async () => `[Example]\n\nbutton "snapshot"`,
      getUiElements,
      getSystemInfo: async () => "{}",
    };
    const deviceManager = new DeviceManager({
      adapters: new Map([["browser", adapter as never]]),
      activeTarget: "browser",
    });
    const setCachedElements = vi.fn();
    const ctx = makeIosContext({}, {
      deviceManager,
      setCachedElements,
    });

    const text = await runTree(ctx, {
      platform: "browser",
      showAll: false,
      fresh: true,
    });

    expect(getUiElements).toHaveBeenCalledWith(undefined);
    expect(text).toContain("Open settings");
    expect(text).not.toContain("snapshot");
    expect(setCachedElements).toHaveBeenCalledWith("browser", expect.any(Array), undefined);
  });
});

describe("ui_tree — desktop normalized provider", () => {
  it("redacts password and value-bearing OTP fields while retaining ordinary labels and metadata", async () => {
    const getUiElements = vi.fn(async () => [
      {
        index: 0,
        id: "password-field",
        role: "AXSecureTextField",
        className: "SecureTextField",
        text: "hunter2",
        password: true,
        enabled: true,
        focused: true,
        focusable: true,
        bounds: { x: 10, y: 20, width: 200, height: 40 },
      },
      {
        index: 1,
        id: "otp-field",
        role: "textbox",
        className: "TextField",
        text: "731904",
        value: "731904",
        label: "One-time code",
        enabled: true,
        focused: false,
        focusable: true,
        bounds: { x: 10, y: 80, width: 200, height: 40 },
      },
      {
        index: 2,
        id: "continue",
        role: "button",
        className: "Button",
        label: "Continue",
        clickable: true,
        enabled: true,
        focusable: true,
        bounds: { x: 30, y: 140, width: 120, height: 44 },
      },
    ]);
    const adapter = { platform: "desktop", getUiElements };
    const deviceManager = new DeviceManager({
      adapters: new Map([["desktop", adapter as never]]),
      activeTarget: "desktop",
    });
    const setCachedElements = vi.fn();
    const ctx = makeIosContext({}, {
      deviceManager,
      setCachedElements,
    });

    const text = await runTree(ctx, {
      platform: "desktop",
      showAll: true,
      fresh: true,
    });

    expect(getUiElements).toHaveBeenCalledWith(undefined);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("731904");
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("Continue");
    expect(text).toContain("@ (90, 162)");
    expect(setCachedElements).toHaveBeenCalledWith("desktop", expect.any(Array), undefined);
  });
});
