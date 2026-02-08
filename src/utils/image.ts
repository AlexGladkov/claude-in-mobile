import { Jimp } from "jimp";
import type { UiElement } from "../adb/ui-parser.js";

export interface CompressOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  maxSizeBytes?: number;
}

const DEFAULT_OPTIONS: CompressOptions = {
  maxWidth: 800,    // Safe for API limit of 2000px
  maxHeight: 1400,  // Safe for API limit of 2000px
  quality: 70,
  maxSizeBytes: 1024 * 1024, // 1MB max for base64 (safe margin for API)
};

/**
 * Compress PNG image buffer
 * - Resize if larger than max dimensions
 * - Convert to JPEG with specified quality
 * - Iteratively reduce quality if still too large
 * Returns base64 encoded JPEG
 */
export async function compressScreenshot(
  pngBuffer: Buffer,
  options: CompressOptions = {}
): Promise<{ data: string; mimeType: string }> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const image = await Jimp.read(pngBuffer);
  const width = image.width;
  const height = image.height;

  // Calculate new dimensions maintaining aspect ratio
  let newWidth = width;
  let newHeight = height;

  if (width > opts.maxWidth! || height > opts.maxHeight!) {
    const widthRatio = opts.maxWidth! / width;
    const heightRatio = opts.maxHeight! / height;
    const ratio = Math.min(widthRatio, heightRatio);

    newWidth = Math.round(width * ratio);
    newHeight = Math.round(height * ratio);
  }

  // Resize if needed
  if (newWidth !== width || newHeight !== height) {
    image.resize({ w: newWidth, h: newHeight });
  }

  // Convert to JPEG with iterative quality reduction if needed
  let quality = opts.quality!;
  let jpegBuffer: Buffer;
  let attempts = 0;
  const maxAttempts = 5;

  do {
    jpegBuffer = await image.getBuffer("image/jpeg", { quality });

    // Check if size is within limit
    if (jpegBuffer.length <= opts.maxSizeBytes!) {
      break;
    }

    // Reduce quality and try again
    quality = Math.max(20, quality - 15);
    attempts++;
  } while (attempts < maxAttempts);

  // If still too large after quality reduction, resize further
  if (jpegBuffer.length > opts.maxSizeBytes!) {
    const scaleFactor = Math.sqrt(opts.maxSizeBytes! / jpegBuffer.length) * 0.9;
    const smallerWidth = Math.round(newWidth * scaleFactor);
    const smallerHeight = Math.round(newHeight * scaleFactor);

    image.resize({ w: smallerWidth, h: smallerHeight });
    jpegBuffer = await image.getBuffer("image/jpeg", { quality: 50 });
  }

  return {
    data: jpegBuffer.toString("base64"),
    mimeType: "image/jpeg",
  };
}

/**
 * Get original image as base64 PNG (no compression)
 */
export function toBase64Png(buffer: Buffer): { data: string; mimeType: string } {
  return {
    data: buffer.toString("base64"),
    mimeType: "image/png",
  };
}

// ──────────────────────────────────────────────
// Annotate Screenshot
// ──────────────────────────────────────────────

// 5x7 bitmap font for digits 0-9 (each row is a 5-bit bitmask)
const DIGIT_FONT: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
};

const COLOR_GREEN = { r: 0, g: 200, b: 0, a: 255 };
const COLOR_RED = { r: 220, g: 50, b: 50, a: 255 };
const COLOR_BG = { r: 0, g: 0, b: 0, a: 180 };
const COLOR_WHITE = { r: 255, g: 255, b: 255, a: 255 };

const RECT_THICKNESS = 3;
const FONT_SCALE = 2; // Scale factor for digit rendering
const LABEL_PADDING = 2;

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function setPixel(
  data: Buffer,
  imgWidth: number,
  x: number,
  y: number,
  color: RGBA
): void {
  if (x < 0 || y < 0 || x >= imgWidth) return;
  const offset = (y * imgWidth + x) * 4;
  if (offset < 0 || offset + 3 >= data.length) return;

  if (color.a === 255) {
    data[offset] = color.r;
    data[offset + 1] = color.g;
    data[offset + 2] = color.b;
    data[offset + 3] = 255;
  } else {
    // Alpha blending
    const a = color.a / 255;
    const ia = 1 - a;
    data[offset] = Math.round(color.r * a + data[offset] * ia);
    data[offset + 1] = Math.round(color.g * a + data[offset + 1] * ia);
    data[offset + 2] = Math.round(color.b * a + data[offset + 2] * ia);
    data[offset + 3] = 255;
  }
}

function drawRect(
  data: Buffer,
  imgWidth: number,
  imgHeight: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: RGBA,
  thickness: number
): void {
  for (let t = 0; t < thickness; t++) {
    // Top and bottom edges
    for (let x = x1; x <= x2; x++) {
      if (y1 + t < imgHeight) setPixel(data, imgWidth, x, y1 + t, color);
      if (y2 - t >= 0) setPixel(data, imgWidth, x, y2 - t, color);
    }
    // Left and right edges
    for (let y = y1; y <= y2; y++) {
      if (x1 + t < imgWidth) setPixel(data, imgWidth, x1 + t, y, color);
      if (x2 - t >= 0) setPixel(data, imgWidth, x2 - t, y, color);
    }
  }
}

function fillRect(
  data: Buffer,
  imgWidth: number,
  imgHeight: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: RGBA
): void {
  for (let y = Math.max(0, y1); y <= Math.min(imgHeight - 1, y2); y++) {
    for (let x = Math.max(0, x1); x <= Math.min(imgWidth - 1, x2); x++) {
      setPixel(data, imgWidth, x, y, color);
    }
  }
}

function drawDigit(
  data: Buffer,
  imgWidth: number,
  imgHeight: number,
  digit: string,
  startX: number,
  startY: number,
  color: RGBA,
  scale: number
): number {
  const rows = DIGIT_FONT[digit];
  if (!rows) return 0;

  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (rows[row] & (1 << (4 - col))) {
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = startX + col * scale + sx;
            const py = startY + row * scale + sy;
            if (px >= 0 && px < imgWidth && py >= 0 && py < imgHeight) {
              setPixel(data, imgWidth, px, py, color);
            }
          }
        }
      }
    }
  }
  return 5 * scale + scale; // width + spacing
}

function drawNumber(
  data: Buffer,
  imgWidth: number,
  imgHeight: number,
  num: number,
  x: number,
  y: number,
  fgColor: RGBA,
  bgColor: RGBA,
  scale: number
): void {
  const str = String(num);
  const charWidth = 5 * scale + scale; // digit width + spacing
  const totalWidth = str.length * charWidth - scale + LABEL_PADDING * 2;
  const totalHeight = 7 * scale + LABEL_PADDING * 2;

  // Draw background
  fillRect(data, imgWidth, imgHeight, x, y, x + totalWidth, y + totalHeight, bgColor);

  // Draw digits
  let cx = x + LABEL_PADDING;
  for (const ch of str) {
    cx += drawDigit(data, imgWidth, imgHeight, ch, cx, y + LABEL_PADDING, fgColor, scale);
  }
}

function getElementLabel(el: UiElement): string {
  if (el.text) return el.text;
  if (el.contentDesc) return el.contentDesc;
  if (el.resourceId) {
    const short = el.resourceId.split(":id/").pop();
    return short ?? el.resourceId;
  }
  const shortClass = el.className.split(".").pop();
  return shortClass ?? el.className;
}

export interface AnnotateResult {
  image: { data: string; mimeType: string };
  elements: Array<{
    index: number;
    label: string;
    clickable: boolean;
    center: { x: number; y: number };
  }>;
}

/**
 * Annotate a screenshot with colored bounding boxes and element numbers.
 * Green = clickable, Red = non-clickable.
 * Returns compressed annotated image + element index.
 */
export async function annotateScreenshot(
  pngBuffer: Buffer,
  elements: UiElement[],
  compressOptions?: CompressOptions
): Promise<AnnotateResult> {
  const image = await Jimp.read(pngBuffer);
  const imgWidth = image.width;
  const imgHeight = image.height;
  const data = image.bitmap.data as Buffer;

  const annotatedElements: AnnotateResult["elements"] = [];
  let annotIndex = 1;

  for (const el of elements) {
    const { x1, y1, x2, y2 } = el.bounds;
    const w = x2 - x1;
    const h = y2 - y1;

    // Skip very small or full-screen elements
    if (w < 10 || h < 10) continue;
    if (w > imgWidth * 0.95 && h > imgHeight * 0.95) continue;

    const color = el.clickable ? COLOR_GREEN : COLOR_RED;

    // Draw bounding box
    drawRect(data, imgWidth, imgHeight, x1, y1, x2, y2, color, RECT_THICKNESS);

    // Draw number label above the top-left corner
    const labelY = Math.max(0, y1 - (7 * FONT_SCALE + LABEL_PADDING * 2) - 2);
    drawNumber(data, imgWidth, imgHeight, annotIndex, x1, labelY, COLOR_WHITE, COLOR_BG, FONT_SCALE);

    annotatedElements.push({
      index: annotIndex,
      label: getElementLabel(el),
      clickable: el.clickable,
      center: { x: el.centerX, y: el.centerY },
    });

    annotIndex++;
  }

  // Compress the annotated image
  const pngOut = await image.getBuffer("image/png");
  const compressed = await compressScreenshot(pngOut, compressOptions);

  return {
    image: compressed,
    elements: annotatedElements,
  };
}
