import type { RGBA } from "./types.js";

/**
 * Low-level pixel buffer drawing primitives + 5x7 bitmap digit font.
 * Operates directly on raw RGBA Buffer data from Jimp's `bitmap.data`.
 */

// 5x7 bitmap font for digits 0-9 (each row is a 5-bit bitmask)
export const DIGIT_FONT: Record<string, number[]> = {
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

export const COLOR_GREEN: RGBA = { r: 0, g: 200, b: 0, a: 255 };
export const COLOR_RED: RGBA = { r: 220, g: 50, b: 50, a: 255 };
export const COLOR_BG: RGBA = { r: 0, g: 0, b: 0, a: 180 };
export const COLOR_WHITE: RGBA = { r: 255, g: 255, b: 255, a: 255 };

export const RECT_THICKNESS = 3;
export const FONT_SCALE = 2;
export const LABEL_PADDING = 2;

export function setPixel(
  data: Buffer,
  imgWidth: number,
  x: number,
  y: number,
  color: RGBA,
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
    const a = color.a / 255;
    const ia = 1 - a;
    data[offset] = Math.round(color.r * a + data[offset] * ia);
    data[offset + 1] = Math.round(color.g * a + data[offset + 1] * ia);
    data[offset + 2] = Math.round(color.b * a + data[offset + 2] * ia);
    data[offset + 3] = 255;
  }
}

export function drawRect(
  data: Buffer,
  imgWidth: number,
  imgHeight: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: RGBA,
  thickness: number,
): void {
  for (let t = 0; t < thickness; t++) {
    for (let x = x1; x <= x2; x++) {
      if (y1 + t < imgHeight) setPixel(data, imgWidth, x, y1 + t, color);
      if (y2 - t >= 0) setPixel(data, imgWidth, x, y2 - t, color);
    }
    for (let y = y1; y <= y2; y++) {
      if (x1 + t < imgWidth) setPixel(data, imgWidth, x1 + t, y, color);
      if (x2 - t >= 0) setPixel(data, imgWidth, x2 - t, y, color);
    }
  }
}

export function fillRect(
  data: Buffer,
  imgWidth: number,
  imgHeight: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: RGBA,
): void {
  for (let y = Math.max(0, y1); y <= Math.min(imgHeight - 1, y2); y++) {
    for (let x = Math.max(0, x1); x <= Math.min(imgWidth - 1, x2); x++) {
      setPixel(data, imgWidth, x, y, color);
    }
  }
}

export function drawDigit(
  data: Buffer,
  imgWidth: number,
  imgHeight: number,
  digit: string,
  startX: number,
  startY: number,
  color: RGBA,
  scale: number,
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

export function drawNumber(
  data: Buffer,
  imgWidth: number,
  imgHeight: number,
  num: number,
  x: number,
  y: number,
  fgColor: RGBA,
  bgColor: RGBA,
  scale: number,
): void {
  const str = String(num);
  const charWidth = 5 * scale + scale;
  const totalWidth = str.length * charWidth - scale + LABEL_PADDING * 2;
  const totalHeight = 7 * scale + LABEL_PADDING * 2;

  fillRect(data, imgWidth, imgHeight, x, y, x + totalWidth, y + totalHeight, bgColor);

  let cx = x + LABEL_PADDING;
  for (const ch of str) {
    cx += drawDigit(data, imgWidth, imgHeight, ch, cx, y + LABEL_PADDING, fgColor, scale);
  }
}
