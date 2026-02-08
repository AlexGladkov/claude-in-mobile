import { describe, it, expect } from "vitest";
import { Jimp } from "jimp";
import { compressScreenshot, annotateScreenshot } from "./image.js";
import type { UiElement, Bounds } from "../adb/ui-parser.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

async function createTestPng(width: number, height: number, color = 0xff0000ff): Promise<Buffer> {
  const image = new Jimp({ width, height, color });
  return await image.getBuffer("image/png");
}

function makeElement(overrides: Partial<UiElement> & { bounds: Bounds }): UiElement {
  return {
    index: 0,
    resourceId: "",
    className: "android.widget.View",
    packageName: "com.test",
    text: "",
    contentDesc: "",
    checkable: false,
    checked: false,
    clickable: false,
    enabled: true,
    focusable: false,
    focused: false,
    scrollable: false,
    longClickable: false,
    password: false,
    selected: false,
    centerX: Math.floor((overrides.bounds.x1 + overrides.bounds.x2) / 2),
    centerY: Math.floor((overrides.bounds.y1 + overrides.bounds.y2) / 2),
    width: overrides.bounds.x2 - overrides.bounds.x1,
    height: overrides.bounds.y2 - overrides.bounds.y1,
    ...overrides,
  };
}

// ──────────────────────────────────────────────
// compressScreenshot
// ──────────────────────────────────────────────

describe("compressScreenshot", () => {
  it("returns base64 JPEG data", async () => {
    const png = await createTestPng(100, 100);
    const result = await compressScreenshot(png);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.data).toBeTruthy();
    // Verify it's valid base64
    const decoded = Buffer.from(result.data, "base64");
    expect(decoded.length).toBeGreaterThan(0);
  });

  it("resizes large images to fit max dimensions", async () => {
    const png = await createTestPng(2000, 3000);
    const result = await compressScreenshot(png, { maxWidth: 400, maxHeight: 700 });
    // Decode and check dimensions
    const decoded = Buffer.from(result.data, "base64");
    const img = await Jimp.read(decoded);
    expect(img.width).toBeLessThanOrEqual(400);
    expect(img.height).toBeLessThanOrEqual(700);
  });

  it("preserves aspect ratio when resizing", async () => {
    const png = await createTestPng(1000, 2000);
    const result = await compressScreenshot(png, { maxWidth: 500, maxHeight: 1000 });
    const decoded = Buffer.from(result.data, "base64");
    const img = await Jimp.read(decoded);
    const ratio = img.width / img.height;
    expect(ratio).toBeCloseTo(0.5, 1);
  });

  it("does not upscale small images", async () => {
    const png = await createTestPng(50, 50);
    const result = await compressScreenshot(png, { maxWidth: 800, maxHeight: 1400 });
    const decoded = Buffer.from(result.data, "base64");
    const img = await Jimp.read(decoded);
    expect(img.width).toBe(50);
    expect(img.height).toBe(50);
  });

  it("respects quality parameter", async () => {
    const png = await createTestPng(200, 200);
    const highQ = await compressScreenshot(png, { quality: 95 });
    const lowQ = await compressScreenshot(png, { quality: 20 });
    const highSize = Buffer.from(highQ.data, "base64").length;
    const lowSize = Buffer.from(lowQ.data, "base64").length;
    expect(highSize).toBeGreaterThan(lowSize);
  });

  it("keeps output under maxSizeBytes", async () => {
    const png = await createTestPng(500, 500);
    const maxSize = 10_000;
    const result = await compressScreenshot(png, { maxSizeBytes: maxSize });
    const decoded = Buffer.from(result.data, "base64");
    expect(decoded.length).toBeLessThanOrEqual(maxSize);
  });
});

// ──────────────────────────────────────────────
// annotateScreenshot
// ──────────────────────────────────────────────

describe("annotateScreenshot", () => {
  const testElements: UiElement[] = [
    makeElement({
      index: 0,
      text: "Login",
      clickable: true,
      className: "android.widget.Button",
      bounds: { x1: 50, y1: 100, x2: 250, y2: 150 },
    }),
    makeElement({
      index: 1,
      text: "Username",
      clickable: false,
      className: "android.widget.TextView",
      bounds: { x1: 50, y1: 50, x2: 250, y2: 80 },
    }),
    makeElement({
      index: 2,
      resourceId: "com.test:id/input_email",
      clickable: true,
      className: "android.widget.EditText",
      bounds: { x1: 50, y1: 160, x2: 250, y2: 200 },
    }),
  ];

  it("returns annotated image with correct format", async () => {
    const png = await createTestPng(300, 300);
    const result = await annotateScreenshot(png, testElements);
    expect(result.image.mimeType).toBe("image/jpeg");
    expect(result.image.data).toBeTruthy();
    const decoded = Buffer.from(result.image.data, "base64");
    expect(decoded.length).toBeGreaterThan(0);
  });

  it("returns element index with labels", async () => {
    const png = await createTestPng(300, 300);
    const result = await annotateScreenshot(png, testElements);
    expect(result.elements.length).toBe(3);
    expect(result.elements[0].index).toBe(1);
    expect(result.elements[0].label).toBe("Login");
    expect(result.elements[0].clickable).toBe(true);
    expect(result.elements[1].label).toBe("Username");
    expect(result.elements[1].clickable).toBe(false);
  });

  it("uses resource ID as label fallback", async () => {
    const png = await createTestPng(300, 300);
    const result = await annotateScreenshot(png, testElements);
    const emailEl = result.elements.find(e => e.label === "input_email");
    expect(emailEl).toBeDefined();
  });

  it("skips very small elements", async () => {
    const elements = [
      makeElement({
        text: "Tiny",
        bounds: { x1: 0, y1: 0, x2: 5, y2: 5 },
      }),
      makeElement({
        text: "Normal",
        clickable: true,
        bounds: { x1: 50, y1: 50, x2: 200, y2: 100 },
      }),
    ];
    const png = await createTestPng(300, 300);
    const result = await annotateScreenshot(png, elements);
    expect(result.elements.length).toBe(1);
    expect(result.elements[0].label).toBe("Normal");
  });

  it("skips full-screen elements", async () => {
    const elements = [
      makeElement({
        text: "Fullscreen",
        bounds: { x1: 0, y1: 0, x2: 300, y2: 300 },
      }),
      makeElement({
        text: "Button",
        clickable: true,
        bounds: { x1: 50, y1: 50, x2: 200, y2: 100 },
      }),
    ];
    const png = await createTestPng(300, 300);
    const result = await annotateScreenshot(png, elements);
    expect(result.elements.length).toBe(1);
    expect(result.elements[0].label).toBe("Button");
  });

  it("handles empty element list", async () => {
    const png = await createTestPng(300, 300);
    const result = await annotateScreenshot(png, []);
    expect(result.elements).toEqual([]);
    // Still returns a valid image
    expect(result.image.data).toBeTruthy();
  });

  it("respects compress options", async () => {
    const png = await createTestPng(300, 300);
    const result = await annotateScreenshot(png, testElements, {
      maxWidth: 150,
      maxHeight: 150,
    });
    const decoded = Buffer.from(result.image.data, "base64");
    const img = await Jimp.read(decoded);
    expect(img.width).toBeLessThanOrEqual(150);
    expect(img.height).toBeLessThanOrEqual(150);
  });

  it("includes center coordinates in element index", async () => {
    const png = await createTestPng(300, 300);
    const result = await annotateScreenshot(png, testElements);
    expect(result.elements[0].center).toEqual({ x: 150, y: 125 });
  });
});
