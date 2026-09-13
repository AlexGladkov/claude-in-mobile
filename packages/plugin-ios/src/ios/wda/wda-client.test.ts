import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WDAClient } from "./wda-client.js";
import { WdaTreeError, unwrapWdaValue } from "./wda-types.js";

/**
 * Trust-boundary regression tests for the WDA HTTP client.
 *
 * WDA is an untrusted external process on localhost:8100. On session
 * degradation it answers HTTP 200 with a `{status:0, value:null, sessionId}`
 * envelope. The previous `response.value || response` unwrap used a falsy
 * check, so `value:null` (falsy) leaked the raw envelope through as if it were a
 * tree/element/rect/size. That silently produced empty parses downstream and
 * poisoned per-platform element caches ("No UI elements detected." on iOS).
 *
 * These tests pin the fix at the source layer — where the response is first
 * coerced to an internal type — instead of relying on a distant downstream
 * validator. There was previously ZERO coverage here.
 */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("unwrapWdaValue — WDA envelope validation", () => {
  it("returns the payload from a healthy envelope", () => {
    const tree = { type: "XCUIElementTypeApplication", children: [] };
    expect(unwrapWdaValue({ status: 0, value: tree }, "tree")).toEqual(tree);
  });

  it("accepts a raw payload without an envelope wrapper", () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    expect(unwrapWdaValue(rect, "rect")).toEqual(rect);
  });

  it("accepts an empty array value (genuine 'no matches')", () => {
    expect(unwrapWdaValue({ status: 0, value: [] }, "findElements")).toEqual([]);
  });

  it("throws WdaTreeError on a degraded {value:null} envelope", () => {
    expect(() =>
      unwrapWdaValue({ status: 0, value: null, sessionId: "S" }, "tree"),
    ).toThrow(WdaTreeError);
  });

  it("throws WdaTreeError on a null response", () => {
    expect(() => unwrapWdaValue(null, "tree")).toThrow(WdaTreeError);
  });

  it("error message names the context and the degradation", () => {
    try {
      unwrapWdaValue({ status: 0, value: null }, "source");
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(WdaTreeError);
      expect(err.message).toContain("source");
      expect(err.message).toContain("WebDriverAgent session");
    }
  });
});

describe("WDAClient — degraded envelope must throw, not leak the wrapper", () => {
  let client: WDAClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new WDAClient(8100);
    // Inject a live session so the guarded methods run their request path.
    (client as unknown as { sessionId: string | null }).sessionId = "TEST";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("getSourceTree throws WdaTreeError on {value:null}", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, value: null, sessionId: "TEST" }),
    );
    await expect(client.getSourceTree()).rejects.toBeInstanceOf(
      WdaTreeError,
    );
  });

  it("getSourceTree returns the tree on a healthy envelope", async () => {
    const tree = {
      type: "XCUIElementTypeApplication",
      rect: { x: 0, y: 0, width: 390, height: 844 },
      children: [],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 0, value: tree }));
    await expect(client.getSourceTree()).resolves.toEqual(tree);
  });

  it("findElement throws WdaTreeError on {value:null} instead of returning the envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, value: null, sessionId: "TEST" }),
    );
    await expect(client.findElement("name", "Foo")).rejects.toBeInstanceOf(
      WdaTreeError,
    );
  });

  it("findElements returns [] on a genuine empty match but throws on {value:null}", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 0, value: [] }));
    await expect(client.findElements("name", "None")).resolves.toEqual([]);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, value: null, sessionId: "TEST" }),
    );
    await expect(client.findElements("name", "None")).rejects.toBeInstanceOf(
      WdaTreeError,
    );
  });

  it("getWindowSize throws WdaTreeError on {value:null}", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, value: null, sessionId: "TEST" }),
    );
    await expect(client.getWindowSize()).rejects.toBeInstanceOf(WdaTreeError);
  });

  it("getElementRect throws WdaTreeError on {value:null}", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: 0, value: null, sessionId: "TEST" }),
    );
    await expect(client.getElementRect("42")).rejects.toBeInstanceOf(
      WdaTreeError,
    );
  });
});

/**
 * The UI tree is only useful if it carries geometry: every downstream consumer
 * (iosTreeToUiElements -> ui(tree), hints, flow) drops nodes without a rect.
 * Real WDA answers /wda/accessibleSource without rects at all, and
 * /source?format=json with them.
 */
describe("WDAClient — the UI tree must carry element geometry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads a source that carries rects, not the geometry-free accessibility tree", async () => {
    const client = new WDAClient(8100);
    (client as unknown as { sessionId: string | null }).sessionId = "TEST";
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes("/wda/accessibleSource")
        ? jsonResponse({ status: 0, value: { type: "XCUIElementTypeApplication", name: "App", children: [] } })
        : jsonResponse({
            status: 0,
            value: {
              type: "XCUIElementTypeApplication",
              rect: { x: 0, y: 0, width: 390, height: 844 },
              children: [],
            },
          }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tree = await client.getSourceTree();

    expect((tree as { rect?: unknown }).rect).toBeDefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8100/session/TEST/source?format=json",
    );
  });
});
