import { describe, it, expect, vi } from "vitest";
import { resolveElementCoordinates } from "./resolve-element.js";
import type { ToolContext } from "../context.js";
import { ElementNotFoundError } from "../../errors.js";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Build a minimal ToolContext with replaceable stubs for each test. */
function makeCtx(overrides: {
  getIosClient?: () => {
    findElement: (...args: any[]) => Promise<any>;
    getElementRect: (...args: any[]) => Promise<any>;
  };
  getCachedElements?: (platform: string) => import("../../adb/ui-parser.js").UiElement[];
  setCachedElements?: (platform: string, elements: import("../../adb/ui-parser.js").UiElement[]) => void;
  getUiHierarchyAsync?: (platform: string) => Promise<string>;
} = {}): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: () => "android",
      getIosClient: overrides.getIosClient ?? (() => {
        throw new Error("getIosClient not configured in this test");
      }),
      getUiHierarchyAsync: overrides.getUiHierarchyAsync ?? (async () => "<hierarchy></hierarchy>"),
    } as any,
    getCachedElements: overrides.getCachedElements ?? (() => []),
    setCachedElements: overrides.setCachedElements ?? (() => {}),
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: async () => "",
    getElementsForPlatform: async () => [],
    iosTreeToUiElements: () => [],
    formatIOSUITree: () => "",
    invalidateUiTreeCache: () => {},
    platformParam: { type: "string", enum: ["android", "ios"], description: "" },
    handleTool: async () => ({ text: "ok" }),
  };
}

/** Minimal UiElement factory — only the fields resolveElementCoordinates actually reads. */
function makeUiElement(
  overrides: Partial<import("../../adb/ui-parser.js").UiElement> = {},
): import("../../adb/ui-parser.js").UiElement {
  return {
    index: 0,
    resourceId: "",
    className: "android.widget.Button",
    packageName: "com.test",
    text: "",
    contentDesc: "",
    checkable: false,
    checked: false,
    clickable: true,
    enabled: true,
    focusable: true,
    focused: false,
    scrollable: false,
    longClickable: false,
    password: false,
    selected: false,
    bounds: { x1: 0, y1: 0, x2: 100, y2: 50 },
    centerX: 50,
    centerY: 25,
    width: 100,
    height: 50,
    ...overrides,
  };
}

/**
 * Build a minimal Android UI hierarchy XML string containing one <node> with
 * the provided text and bounds.
 */
function makeAndroidXml(
  text: string,
  bounds: string = "[0,0][100,50]",
  resourceId: string = "",
): string {
  return (
    `<hierarchy>` +
    `<node index="0" text="${text}" resource-id="${resourceId}" ` +
    `class="android.widget.Button" package="com.test" ` +
    `content-desc="" checkable="false" checked="false" clickable="true" ` +
    `enabled="true" focusable="true" focused="false" scrollable="false" ` +
    `long-clickable="false" password="false" selected="false" ` +
    `bounds="${bounds}" />` +
    `</hierarchy>`
  );
}

// ─────────────────────────────────────────────────────────────
// iOS label-based resolution
// ─────────────────────────────────────────────────────────────

describe("resolveElementCoordinates — iOS with label", () => {
  it("calls findElement + getElementRect and returns center coordinates", async () => {
    const findElement = vi.fn().mockResolvedValue({ ELEMENT: "el-1" });
    const getElementRect = vi.fn().mockResolvedValue({ x: 10, y: 20, width: 80, height: 40 });

    const ctx = makeCtx({ getIosClient: () => ({ findElement, getElementRect }) });
    const result = await resolveElementCoordinates({ label: "Submit" }, ctx, "ios");

    expect(findElement).toHaveBeenCalledOnce();
    expect(findElement).toHaveBeenCalledWith({ text: undefined, label: "Submit" });
    expect(getElementRect).toHaveBeenCalledWith("el-1");

    expect(result).not.toBeNull();
    expect(result!.x).toBe(50);  // 10 + 80/2
    expect(result!.y).toBe(40);  // 20 + 40/2
    expect(result!.fromRawArgs).toBe(false);
    expect(result!.iosTapDone).toBeUndefined();
  });

  it("returns iosTapDone:true + elementId when getElementRect returns null", async () => {
    const findElement = vi.fn().mockResolvedValue({ ELEMENT: "el-42" });
    const getElementRect = vi.fn().mockResolvedValue(null);

    const ctx = makeCtx({ getIosClient: () => ({ findElement, getElementRect }) });
    const result = await resolveElementCoordinates({ label: "Cancel" }, ctx, "ios");

    expect(result).not.toBeNull();
    expect(result!.iosTapDone).toBe(true);
    expect(result!.elementId).toBe("el-42");
    expect(result!.x).toBe(0);
    expect(result!.y).toBe(0);
  });

  it("throws ElementNotFoundError when findElement throws", async () => {
    const findElement = vi.fn().mockRejectedValue(new Error("WDA element not found"));
    const getElementRect = vi.fn();

    const ctx = makeCtx({ getIosClient: () => ({ findElement, getElementRect }) });
    await expect(
      resolveElementCoordinates({ label: "NonExistent" }, ctx, "ios"),
    ).rejects.toThrow(ElementNotFoundError);
  });

  it("uses text arg when label is absent", async () => {
    const findElement = vi.fn().mockResolvedValue({ ELEMENT: "el-text" });
    const getElementRect = vi.fn().mockResolvedValue({ x: 0, y: 0, width: 100, height: 60 });

    const ctx = makeCtx({ getIosClient: () => ({ findElement, getElementRect }) });
    const result = await resolveElementCoordinates({ text: "Login" }, ctx, "ios");

    expect(findElement).toHaveBeenCalledWith({ text: "Login", label: undefined });
    expect(result!.description).toBe("Login");
  });
});

// ─────────────────────────────────────────────────────────────
// Android index-based resolution
// ─────────────────────────────────────────────────────────────

describe("resolveElementCoordinates — Android with index", () => {
  it("returns cached element coordinates when cache is populated", async () => {
    const cachedEl = makeUiElement({ index: 3, centerX: 150, centerY: 75 });
    const getCachedElements = vi.fn().mockReturnValue([
      makeUiElement({ index: 0 }),
      makeUiElement({ index: 1 }),
      makeUiElement({ index: 2 }),
      cachedEl,
    ]);
    const setCachedElements = vi.fn();

    const ctx = makeCtx({ getCachedElements, setCachedElements });
    const result = await resolveElementCoordinates({ index: 3 }, ctx, "android");

    expect(result).not.toBeNull();
    expect(result!.x).toBe(150);
    expect(result!.y).toBe(75);
    expect(result!.description).toBe("index 3");
    expect(result!.fromRawArgs).toBe(false);
    // Should NOT have fetched fresh UI hierarchy — cache was enough
  });

  it("fetches UI hierarchy when cache is empty and finds element by index", async () => {
    const xml = makeAndroidXml("Tap me", "[20,10][120,60]");
    const getUiHierarchyAsync = vi.fn().mockResolvedValue(xml);
    const getCachedElements = vi.fn().mockReturnValue([]);
    const setCachedElements = vi.fn();

    const ctx = makeCtx({ getCachedElements, setCachedElements, getUiHierarchyAsync });
    const result = await resolveElementCoordinates({ index: 0 }, ctx, "android");

    expect(getUiHierarchyAsync).toHaveBeenCalledWith("android", undefined);
    expect(result).not.toBeNull();
    // bounds [20,10][120,60] => centerX = (20+120)/2 = 70, centerY = (10+60)/2 = 35
    expect(result!.x).toBe(70);
    expect(result!.y).toBe(35);
  });

  it("throws ElementNotFoundError when index is not in hierarchy", async () => {
    const xml = makeAndroidXml("Only element");
    const getUiHierarchyAsync = vi.fn().mockResolvedValue(xml);
    const getCachedElements = vi.fn().mockReturnValue([]);

    const ctx = makeCtx({ getCachedElements, getUiHierarchyAsync });
    await expect(
      resolveElementCoordinates({ index: 99 }, ctx, "android"),
    ).rejects.toThrow(ElementNotFoundError);
  });
});

// ─────────────────────────────────────────────────────────────
// Android text-based resolution
// ─────────────────────────────────────────────────────────────

describe("resolveElementCoordinates — Android with text", () => {
  it("calls getUiHierarchyAsync and returns element center when text matches", async () => {
    const xml = makeAndroidXml("Login", "[0,0][200,100]");
    const getUiHierarchyAsync = vi.fn().mockResolvedValue(xml);
    const setCachedElements = vi.fn();

    const ctx = makeCtx({ getUiHierarchyAsync, setCachedElements });
    const result = await resolveElementCoordinates({ text: "Login" }, ctx, "android");

    expect(getUiHierarchyAsync).toHaveBeenCalledWith("android", undefined);
    expect(result).not.toBeNull();
    // centerX = 100, centerY = 50
    expect(result!.x).toBe(100);
    expect(result!.y).toBe(50);
    expect(result!.description).toBe("Login");
    expect(result!.fromRawArgs).toBe(false);
  });

  it("throws ElementNotFoundError when text is not found in hierarchy", async () => {
    const xml = makeAndroidXml("SomethingElse");
    const getUiHierarchyAsync = vi.fn().mockResolvedValue(xml);

    const ctx = makeCtx({ getUiHierarchyAsync });
    await expect(
      resolveElementCoordinates({ text: "NotPresent" }, ctx, "android"),
    ).rejects.toThrow(ElementNotFoundError);
  });
});

// ─────────────────────────────────────────────────────────────
// Raw x/y coordinates
// ─────────────────────────────────────────────────────────────

describe("resolveElementCoordinates — raw x/y coordinates", () => {
  it("returns fromRawArgs:true with x and y when both are provided", async () => {
    const ctx = makeCtx();
    const result = await resolveElementCoordinates({ x: 300, y: 450 }, ctx, "android");

    expect(result).not.toBeNull();
    expect(result!.x).toBe(300);
    expect(result!.y).toBe(450);
    expect(result!.fromRawArgs).toBe(true);
    expect(result!.description).toBe("(300, 450)");
  });

  it("returns fromRawArgs:true for iOS with x/y when no label or text", async () => {
    const ctx = makeCtx();
    const result = await resolveElementCoordinates({ x: 50, y: 80 }, ctx, "ios");

    expect(result).not.toBeNull();
    expect(result!.fromRawArgs).toBe(true);
    expect(result!.x).toBe(50);
    expect(result!.y).toBe(80);
  });
});

// ─────────────────────────────────────────────────────────────
// No coordinates at all
// ─────────────────────────────────────────────────────────────

describe("resolveElementCoordinates — no coordinates", () => {
  it("returns null when args contain no resolvable coordinate info", async () => {
    const ctx = makeCtx();
    const result = await resolveElementCoordinates({}, ctx, "android");
    expect(result).toBeNull();
  });

  it("returns null when only unrelated fields are present", async () => {
    const ctx = makeCtx();
    const result = await resolveElementCoordinates({ action: "tap", platform: "android" }, ctx, "android");
    expect(result).toBeNull();
  });
});
