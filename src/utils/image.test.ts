import { describe, it, expect } from "vitest";
import { Jimp } from "jimp";
import { compressScreenshot, annotateScreenshot, compareScreenshots, cropRegion } from "./image.js";
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

// ──────────────────────────────────────────────
// Feature 1: compareScreenshots
// ──────────────────────────────────────────────

describe("compareScreenshots", () => {
  it("returns 0% for identical images", async () => {
    const png = await createTestPng(100, 100, 0xff0000ff);
    const result = await compareScreenshots(png, png);
    expect(result.changePercent).toBe(0);
    expect(result.changedRegion).toBeNull();
    expect(result.changedPixels).toBe(0);
  });

  it("returns 100% for different-sized images", async () => {
    const small = await createTestPng(50, 50);
    const large = await createTestPng(100, 100);
    const result = await compareScreenshots(small, large);
    expect(result.changePercent).toBe(100);
  });

  it("detects fully different images", async () => {
    const red = await createTestPng(100, 100, 0xff0000ff);
    const blue = await createTestPng(100, 100, 0x0000ffff);
    const result = await compareScreenshots(red, blue);
    expect(result.changePercent).toBeGreaterThan(90);
    expect(result.changedRegion).not.toBeNull();
  });

  it("detects partial changes", async () => {
    // Create two images, modify a portion of the second
    const img1 = new Jimp({ width: 100, height: 100, color: 0xff0000ff });
    const img2 = new Jimp({ width: 100, height: 100, color: 0xff0000ff });
    // Paint a 20x20 block blue in image 2
    for (let y = 40; y < 60; y++) {
      for (let x = 40; x < 60; x++) {
        const offset = (y * 100 + x) * 4;
        (img2.bitmap.data as Buffer)[offset] = 0;
        (img2.bitmap.data as Buffer)[offset + 2] = 255;
      }
    }
    const png1 = await img1.getBuffer("image/png");
    const png2 = await img2.getBuffer("image/png");
    const result = await compareScreenshots(png1, png2);
    expect(result.changePercent).toBeGreaterThan(0);
    expect(result.changePercent).toBeLessThan(50);
    expect(result.changedRegion).not.toBeNull();
    expect(result.changedRegion!.x).toBeGreaterThanOrEqual(38);
    expect(result.changedRegion!.y).toBeGreaterThanOrEqual(38);
  });

  it("respects threshold parameter", async () => {
    const img1 = new Jimp({ width: 50, height: 50, color: 0x808080ff });
    const img2 = new Jimp({ width: 50, height: 50, color: 0x858585ff });
    const png1 = await img1.getBuffer("image/png");
    const png2 = await img2.getBuffer("image/png");
    // Low threshold should detect changes
    const sensResult = await compareScreenshots(png1, png2, 1);
    // High threshold should not
    const relaxResult = await compareScreenshots(png1, png2, 100);
    expect(sensResult.changePercent).toBeGreaterThan(relaxResult.changePercent);
  });
});

// ──────────────────────────────────────────────
// Feature 1: cropRegion
// ──────────────────────────────────────────────

describe("cropRegion", () => {
  it("crops the specified region", async () => {
    const png = await createTestPng(200, 200);
    const cropped = await cropRegion(png, { x: 50, y: 50, width: 100, height: 100 });
    const img = await Jimp.read(cropped);
    // With 20px padding: width should be min(200-30, 100+40) = 140
    expect(img.width).toBeLessThanOrEqual(140);
    expect(img.height).toBeLessThanOrEqual(140);
    expect(img.width).toBeGreaterThan(0);
    expect(img.height).toBeGreaterThan(0);
  });

  it("handles edge regions with padding", async () => {
    const png = await createTestPng(100, 100);
    // Region near edge — padding should be clamped
    const cropped = await cropRegion(png, { x: 0, y: 0, width: 30, height: 30 }, 10);
    const img = await Jimp.read(cropped);
    expect(img.width).toBeLessThanOrEqual(50);
    expect(img.height).toBeLessThanOrEqual(50);
  });
});
