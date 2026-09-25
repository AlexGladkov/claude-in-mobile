import { describe, it, expect, beforeEach, vi } from "vitest";
import type { UiElement } from "../../ui-tree/ui-parser.js";
import { SharedState, screenshotStateKey } from "./shared-state-class.js";
import {
  getCachedElements,
  setCachedElements,
} from "./shared-state.js";
import { createGetElementsForPlatform } from "./hints.js";
import { iosTreeToUiElements } from "./ios-helpers.js";

/**
 * Regression guards for cache ownership:
 * - a valid empty accessibility tree must clear stale coordinates;
 * - degraded reads must throw before any cache write.
 *
 * The real SharedState and shared-state module are exercised here because
 * caller-level guards alone do not prove the cache owner has the right policy.
 */

function validWdaEnvelope() {
  return JSON.stringify({
    status: 0,
    sessionId: "TEST-SESSION",
    value: {
      type: "XCUIElementTypeApplication",
      rect: { x: 0, y: 0, width: 390, height: 844 },
      children: [
        {
          type: "XCUIElementTypeButton",
          label: "Continue",
          enabled: true,
          rect: { x: 20, y: 700, width: 350, height: 44 },
        },
      ],
    },
  });
}

function degradedWdaEnvelope() {
  return JSON.stringify({ status: 0, value: null, sessionId: "TEST-SESSION" });
}

function sampleElements(): UiElement[] {
  return iosTreeToUiElements(JSON.parse(validWdaEnvelope()));
}

describe("SharedState.setCachedElements — owner-level cache invariant", () => {
  let state: SharedState;

  beforeEach(() => {
    state = new SharedState();
  });

  it("stores a non-empty read", () => {
    const els = sampleElements();
    state.setCachedElements("ios", els);
    expect(state.getCachedElements("ios")).toEqual(els);
  });

  it("clears stale coordinates when a valid read is empty", () => {
    const good = sampleElements();
    state.setCachedElements("ios", good);

    // A successful empty tree is authoritative and must replace the old list.
    state.setCachedElements("ios", []);

    expect(state.getCachedElements("ios")).toEqual([]);
  });

  it("marks indexed reads stale while retaining the pre-action hint state", () => {
    const good = sampleElements();
    state.setCachedElements("android", good);

    state.invalidateUiTreeCache("android");

    expect(state.isCachedElementsStale("android")).toBe(true);
    expect(state.getCachedElements("android")).toEqual(good);

    state.setCachedElements("android", []);
    expect(state.isCachedElementsStale("android")).toBe(false);
  });

  it("allows a successful empty write to clear an existing cache", () => {
    const good = sampleElements();
    state.setCachedElements("android", good);
    state.setCachedElements("android", []);
    expect(state.getCachedElements("android")).toEqual([]);
  });

  it("isolates caches per platform", () => {
    const els = sampleElements();
    state.setCachedElements("ios", els);
    state.setCachedElements("android", []); // empty, different platform
    expect(state.getCachedElements("ios").length).toBeGreaterThan(0);
    expect(state.getCachedElements("android")).toEqual([]);
  });
  it("isolates element indexes per device on the same platform", () => {
    const first = sampleElements();
    const second = sampleElements().map((element) => ({ ...element, text: "Other device" }));

    state.setCachedElements("android", first, "phone-a");
    state.setCachedElements("android", second, "phone-b");

    expect(state.getCachedElements("android", "phone-a")).toEqual(first);
    expect(state.getCachedElements("android", "phone-b")).toEqual(second);
    expect(state.getCachedElements("android")).toEqual([]);
  });
  it("invalidates only a device whose ID is not a colon-delimited prefix", () => {
    const shortDeviceId = "192.168.1.2";
    const longDeviceId = `${shortDeviceId}:5555`;
    const shortKey = `${screenshotStateKey("android", shortDeviceId)}:false:false`;
    const longKey = `${screenshotStateKey("android", longDeviceId)}:false:false`;
    state.lastUiTreeMap.set(shortKey, { text: "short", timestamp: 1 });
    state.lastUiTreeMap.set(longKey, { text: "long", timestamp: 1 });

    state.invalidateUiTreeCache("android", shortDeviceId);

    expect(state.lastUiTreeMap.has(shortKey)).toBe(false);
    expect(state.lastUiTreeMap.has(longKey)).toBe(true);
  });
});


describe("getElementsForPlatform — second cache writer must not self-poison", () => {
  let mockDeviceManager: any;

  beforeEach(() => {
    // Clear the process-wide singleton that shared-state.ts is bound to, so
    // each test starts from a clean cache without swapping the import-captured
    // `_state` reference.
    for (const platform of ["ios", "android", "desktop"]) {
      setCachedElements(platform, []);
    }

    mockDeviceManager = {
      getCurrentPlatform: vi.fn(() => "ios"),
      getUiHierarchy: vi.fn(),
      getUiHierarchyAsync: vi.fn(),
    };
  });

  it("keeps a previously-good iOS cache when a degraded fetch throws", async () => {
    const getElements = createGetElementsForPlatform(mockDeviceManager);

    // Seed a good cache through the real writer.
    mockDeviceManager.getUiHierarchy.mockResolvedValueOnce(validWdaEnvelope());
    const first = await getElements("ios");
    expect(first.length).toBeGreaterThan(0);
    expect(getCachedElements("ios").length).toBeGreaterThan(0);

    // Degraded fetch: iosTreeToUiElements throws WdaTreeError before any
    // setCachedElements("ios", []) can run — so the cache survives.
    mockDeviceManager.getUiHierarchy.mockResolvedValueOnce(
      degradedWdaEnvelope(),
    );
    await expect(getElements("ios")).rejects.toThrow();

    // Cache must still hold the good elements, never poisoned to [].
    expect(getCachedElements("ios").length).toBeGreaterThan(0);
  });

  it("allows a successful empty read to clear the cache", () => {
    const good = sampleElements();
    setCachedElements("ios", good);
    setCachedElements("ios", []);

    expect(getCachedElements("ios")).toEqual([]);
  });
});
