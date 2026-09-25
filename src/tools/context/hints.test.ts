import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { UiElement } from "../../ui-tree/ui-parser.js";
import { iosTreeToUiElements, WdaTreeError } from "./ios-helpers.js";

/**
 * Test suite for createGenerateActionHints with cache self-poisoning guard (Bug B)
 * and WDA tree validation (Bug A).
 *
 * INVARIANT: Cache must NEVER be overwritten with empty results. When getUiHierarchy
 * returns a degraded/null response, the hints catch-block must distinguish that from
 * a genuine empty UI, and setCachedElements must not be called with [].
 *
 * Imported AFTER vi.mock setup so we get the mocked version.
 */

// Realistic iOS WDA envelope with valid elements
function validWdaEnvelope() {
  return {
    status: 0,
    sessionId: "TEST-SESSION",
    value: {
      type: "XCUIElementTypeApplication",
      rect: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        {
          type: "XCUIElementTypeStaticText",
          label: "Home",
          rect: { x: 20, y: 60, width: 200, height: 30 },
        },
        {
          type: "XCUIElementTypeButton",
          label: "Continue",
          enabled: true,
          rect: { x: 20, y: 700, width: 350, height: 44 },
        },
      ],
    },
  };
}

// Degraded WDA envelope: HTTP 200 but value:null
function degradedWdaEnvelope() {
  return { status: 0, value: null, sessionId: "TEST-SESSION" };
}

describe("createGenerateActionHints — WDA tree validation (Bug A)", () => {
  it("throws WdaTreeError when WDA returns value:null", () => {
    // Direct test: iosTreeToUiElements must throw on degraded envelope
    expect(() => {
      iosTreeToUiElements(degradedWdaEnvelope());
    }).toThrow(WdaTreeError);
  });

  it("unwrapWdaTree distinguishes degraded envelope from valid tree", () => {
    // When we try to parse a degraded envelope, it must throw, not silently
    // return [] which would poison the cache.
    const degraded = degradedWdaEnvelope();
    expect(() => iosTreeToUiElements(degraded)).toThrow(WdaTreeError);

    // Valid envelope works fine
    const valid = validWdaEnvelope();
    const elements = iosTreeToUiElements(valid);
    expect(elements.length).toBeGreaterThan(0);
  });

  it("error message clearly indicates WDA session degradation", () => {
    try {
      iosTreeToUiElements(degradedWdaEnvelope());
      expect.unreachable("Should have thrown WdaTreeError");
    } catch (err: any) {
      expect(err).toBeInstanceOf(WdaTreeError);
      expect(err.message).toContain("WDA returned an empty accessibility tree");
      expect(err.message).toContain("WebDriverAgent session");
    }
  });
});

describe("createGenerateActionHints — cache self-poisoning guard (Bug B)", () => {
  let mockDeviceManager: any;
  let setCachedElements: ReturnType<typeof vi.fn>;
  let getCachedElements: ReturnType<typeof vi.fn>;
  let createGenerateActionHints: any;

  beforeEach(async () => {
    // Mock the shared-state module BEFORE importing createGenerateActionHints
    setCachedElements = vi.fn();
    getCachedElements = vi.fn(() => []);

    vi.doMock("./shared-state.js", () => ({
      getCachedElements: getCachedElements,
      setCachedElements: setCachedElements,
      lastScreenshotMap: new Map(),
      lastUiTreeMap: new Map(),
      screenshotScaleMap: new Map(),
      invalidateUiTreeCache: vi.fn(),
    }));

    // Now import the module which will use the mocked shared-state
    const hints = await import("./hints.js");
    createGenerateActionHints = hints.createGenerateActionHints;

    mockDeviceManager = {
      getCurrentPlatform: vi.fn(() => "ios"),
      getUiHierarchy: vi.fn(),
      getUiHierarchyAsync: vi.fn(),
    };
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("does NOT write empty array to cache when WDA returns degraded envelope", async () => {
    const generateHints = createGenerateActionHints(mockDeviceManager);

    // Return degraded envelope (value:null)
    mockDeviceManager.getUiHierarchy.mockResolvedValueOnce(
      JSON.stringify(degradedWdaEnvelope()),
    );

    const hints = await generateHints("ios");

    // Must report the error, not cache an empty array
    expect(hints).toContain("Unable to fetch UI state");

    // CRITICAL: setCachedElements must NOT have been called with []
    const callsWithEmptyArray = setCachedElements.mock.calls.filter(
      (call: any) => Array.isArray(call[1]) && call[1].length === 0,
    );
    expect(callsWithEmptyArray.length).toBe(0);
  });

  it("writes valid elements to cache on successful fetch", async () => {
    const generateHints = createGenerateActionHints(mockDeviceManager);

    mockDeviceManager.getUiHierarchy.mockResolvedValueOnce(
      JSON.stringify(validWdaEnvelope()),
    );

    const hints = await generateHints("ios");

    expect(hints).toContain("Hints");
    expect(hints).toContain("Elements:");

    // setCachedElements should have been called with non-empty array
    expect(setCachedElements).toHaveBeenCalledWith(
      "ios",
      expect.any(Array),
      undefined,
    );

    const cachedCall = setCachedElements.mock.calls.find(
      (call: any) => call[0] === "ios",
    );
    expect(cachedCall).toBeDefined();
    expect(cachedCall[1].length).toBeGreaterThan(0);
  });

  it("preserves cache when subsequent fetch fails", async () => {
    const generateHints = createGenerateActionHints(mockDeviceManager);

    // First call succeeds
    mockDeviceManager.getUiHierarchy.mockResolvedValueOnce(
      JSON.stringify(validWdaEnvelope()),
    );
    const hints1 = await generateHints("ios");
    expect(hints1).toContain("Hints");

    // Simulate cache being populated with valid elements
    const cachedElements = iosTreeToUiElements(validWdaEnvelope());
    getCachedElements.mockReturnValueOnce(cachedElements);

    // Second call gets degraded envelope
    mockDeviceManager.getUiHierarchy.mockResolvedValueOnce(
      JSON.stringify(degradedWdaEnvelope()),
    );
    const hints2 = await generateHints("ios");

    // Error is reported
    expect(hints2).toContain("Unable to fetch UI state");

    // Verify no empty-array cache write occurred after error
    const allCalls = setCachedElements.mock.calls;
    const emptyWrites = allCalls.filter(
      (call: any) => Array.isArray(call[1]) && call[1].length === 0,
    );
    expect(emptyWrites.length).toBe(0);
  });
});

describe("createGenerateActionHints — cascade prevention", () => {
  let mockDeviceManager: any;
  let setCachedElements: ReturnType<typeof vi.fn>;
  let getCachedElements: ReturnType<typeof vi.fn>;
  let createGenerateActionHints: any;
  let createGetElementsForPlatform: any;

  beforeEach(async () => {
    // Mock shared-state
    setCachedElements = vi.fn();
    const cacheStore = new Map<string, UiElement[]>();

    getCachedElements = vi.fn((platform: string) => {
      return cacheStore.get(platform) ?? [];
    });

    setCachedElements.mockImplementation((platform: string, elements: UiElement[]) => {
      if (elements.length > 0) {
        cacheStore.set(platform, elements);
      }
      // Silently ignore empty writes (cache guard in effect)
    });

    vi.doMock("./shared-state.js", () => ({
      getCachedElements: getCachedElements,
      setCachedElements: setCachedElements,
      lastScreenshotMap: new Map(),
      lastUiTreeMap: new Map(),
      screenshotScaleMap: new Map(),
      invalidateUiTreeCache: vi.fn(),
    }));

    const hints = await import("./hints.js");
    createGenerateActionHints = hints.createGenerateActionHints;
    createGetElementsForPlatform = hints.createGetElementsForPlatform;

    mockDeviceManager = {
      getCurrentPlatform: vi.fn(() => "ios"),
      getUiHierarchy: vi.fn(),
      getUiHierarchyAsync: vi.fn(),
    };
  });
  it("routes external UI provider elements to hints and flow predicates", async () => {
    mockDeviceManager.getCurrentPlatform.mockReturnValue("tizen");
    const getUiElements = vi.fn(async () => [{
      id: "continue",
      role: "button",
      text: "Continue",
      clickable: true,
      bounds: { x: 10, y: 20, width: 100, height: 40 },
    }]);
    mockDeviceManager.getAdapter = vi.fn(() => ({ getUiElements }));

    const getElementsForPlatform = createGetElementsForPlatform(mockDeviceManager);
    const elements = await getElementsForPlatform("tizen", "tizen-2");

    expect(getUiElements).toHaveBeenCalledWith("tizen-2");
    expect(elements).toMatchObject([{ resourceId: "continue", text: "Continue", clickable: true }]);

    const hints = await createGenerateActionHints(mockDeviceManager)("tizen", "tizen-2");
    expect(hints).toContain("Elements: 1 -> 1");
    expect(hints).not.toContain("No UI elements detected");
  });

  it("routes desktop UI through the normalized provider path", async () => {
    mockDeviceManager.getCurrentPlatform.mockReturnValue("desktop");
    const getUiElements = vi.fn(async () => [{
      role: "textbox",
      className: "TextField",
      text: "731904",
      value: "731904",
      label: "One-time code",
      bounds: { x: 10, y: 20, width: 100, height: 40 },
    }]);
    mockDeviceManager.getAdapter = vi.fn(() => ({ getUiElements }));

    const getElementsForPlatform = createGetElementsForPlatform(mockDeviceManager);
    const elements = await getElementsForPlatform("desktop");

    expect(getUiElements).toHaveBeenCalledWith(undefined);
    expect(elements).toMatchObject([{
      password: true,
      text: "[REDACTED]",
      contentDesc: "[REDACTED]",
      resourceId: "[REDACTED]",
    }]);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("prevents 'No UI elements detected' cascade after degraded WDA read", async () => {
    /**
     * Bug B scenario: Single degraded read used to poison cache.
     * Fix: cache-guard gate `if (afterElements.length > 0)` prevents the poison.
     *
     * This test verifies:
     * 1. First call succeeds, populates cache
     * 2. Second call: WDA returns null, throws, no cache write
     * 3. Cache still contains valid elements
     * 4. Third call: WDA recovers, hints diff against valid cache (not [])
     */

    const generateHints = createGenerateActionHints(mockDeviceManager);

    // Call 1: Success
    mockDeviceManager.getUiHierarchy.mockResolvedValueOnce(
      JSON.stringify(validWdaEnvelope()),
    );
    const hints1 = await generateHints("ios");
    expect(hints1).toContain("Hints");

    // Call 2: Degraded read
    mockDeviceManager.getUiHierarchy.mockResolvedValueOnce(
      JSON.stringify(degradedWdaEnvelope()),
    );
    const hints2 = await generateHints("ios");
    expect(hints2).toContain("Unable to fetch UI state");

    // Call 3: WDA recovers (different tree)
    const recoveredEnvelope = {
      status: 0,
      sessionId: "TEST-SESSION",
      value: {
        type: "XCUIElementTypeApplication",
        rect: { x: 0, y: 0, width: 390, height: 844 },
        children: [
          {
            type: "XCUIElementTypeButton",
            label: "New Button",
            enabled: true,
            rect: { x: 20, y: 700, width: 350, height: 44 },
          },
        ],
      },
    };

    mockDeviceManager.getUiHierarchy.mockResolvedValueOnce(
      JSON.stringify(recoveredEnvelope),
    );
    const hints3 = await generateHints("ios");

    // Must NOT report "No UI elements detected" — cache was not poisoned
    expect(hints3).not.toContain("No UI elements detected");
    expect(hints3).toContain("Hints");
  });
});
