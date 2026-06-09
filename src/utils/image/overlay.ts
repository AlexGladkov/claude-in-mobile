import { Jimp } from "jimp";
import type { DiffOverlayResult, DiffRegion, RGBA } from "./types.js";
import {
  COLOR_BG,
  COLOR_WHITE,
  drawNumber,
  drawRect,
  FONT_SCALE,
  LABEL_PADDING,
} from "./drawing.js";

const COLOR_DIFF_OVERLAY: RGBA = { r: 240, g: 170, b: 40, a: 153 }; // #F0AA28, alpha 60%
const COLOR_DIFF_BORDER: RGBA = { r: 240, g: 170, b: 40, a: 255 };
const DIFF_BORDER_THICKNESS = 2;

// Grid-based region clustering: divide image into cells, group adjacent changed cells
const CLUSTER_CELL_SIZE = 40; // px
const MIN_REGION_PIXELS = 100; // Ignore regions smaller than this

/**
 * Generate a diff overlay image highlighting changed pixels between baseline and current.
 * Orange overlay on changed pixels, bounding boxes around changed regions, numbered labels.
 */
export async function generateDiffOverlay(
  baseline: Buffer,
  current: Buffer,
  options?: {
    threshold?: number;
    ignoreRegions?: DiffRegion[];
  },
): Promise<DiffOverlayResult> {
  const baseImg = await Jimp.read(baseline);
  const currImg = await Jimp.read(current);

  if (baseImg.width !== currImg.width || baseImg.height !== currImg.height) {
    return {
      image: await currImg.getBuffer("image/png"),
      regions: [{ x: 0, y: 0, width: currImg.width, height: currImg.height }],
      changePercent: 100,
      changedPixels: currImg.width * currImg.height,
      totalPixels: currImg.width * currImg.height,
    };
  }

  const w = currImg.width;
  const h = currImg.height;
  const baseData = baseImg.bitmap.data as Buffer;
  const currData = currImg.bitmap.data as Buffer;
  const threshold = options?.threshold ?? 30;
  const thresholdSum = threshold * 3;
  const ignoreRegions = options?.ignoreRegions ?? [];

  const isIgnored = (px: number, py: number): boolean => {
    for (const r of ignoreRegions) {
      if (px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height) return true;
    }
    return false;
  };

  const gridW = Math.ceil(w / CLUSTER_CELL_SIZE);
  const gridH = Math.ceil(h / CLUSTER_CELL_SIZE);
  const grid = new Uint8Array(gridW * gridH);

  const overlay = currImg.clone();
  const overlayData = overlay.bitmap.data as Buffer;

  let changedPixels = 0;
  let totalPixels = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isIgnored(x, y)) continue;
      totalPixels++;
      const offset = (y * w + x) * 4;
      const dr = Math.abs(baseData[offset] - currData[offset]);
      const dg = Math.abs(baseData[offset + 1] - currData[offset + 1]);
      const db = Math.abs(baseData[offset + 2] - currData[offset + 2]);

      if (dr + dg + db > thresholdSum) {
        changedPixels++;
        const a = COLOR_DIFF_OVERLAY.a / 255;
        const ia = 1 - a;
        overlayData[offset] = Math.round(COLOR_DIFF_OVERLAY.r * a + currData[offset] * ia);
        overlayData[offset + 1] = Math.round(COLOR_DIFF_OVERLAY.g * a + currData[offset + 1] * ia);
        overlayData[offset + 2] = Math.round(COLOR_DIFF_OVERLAY.b * a + currData[offset + 2] * ia);
        const gx = Math.floor(x / CLUSTER_CELL_SIZE);
        const gy = Math.floor(y / CLUSTER_CELL_SIZE);
        grid[gy * gridW + gx] = 1;
      }
    }
  }

  const changePercent = totalPixels > 0
    ? Math.round((changedPixels / totalPixels) * 1000) / 10
    : 0;

  // Cluster grid cells into regions using flood fill
  const visited = new Uint8Array(gridW * gridH);
  const regions: DiffRegion[] = [];

  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const idx = gy * gridW + gx;
      if (grid[idx] === 0 || visited[idx]) continue;
      let minGx = gx, maxGx = gx, minGy = gy, maxGy = gy;
      const stack = [idx];
      visited[idx] = 1;
      while (stack.length > 0) {
        const ci = stack.pop()!;
        const cx = ci % gridW;
        const cy = Math.floor(ci / gridW);
        if (cx < minGx) minGx = cx;
        if (cx > maxGx) maxGx = cx;
        if (cy < minGy) minGy = cy;
        if (cy > maxGy) maxGy = cy;
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
          const ni = ny * gridW + nx;
          if (grid[ni] === 1 && !visited[ni]) {
            visited[ni] = 1;
            stack.push(ni);
          }
        }
      }
      const regionX = minGx * CLUSTER_CELL_SIZE;
      const regionY = minGy * CLUSTER_CELL_SIZE;
      const regionW = Math.min((maxGx + 1) * CLUSTER_CELL_SIZE, w) - regionX;
      const regionH = Math.min((maxGy + 1) * CLUSTER_CELL_SIZE, h) - regionY;
      if (regionW * regionH >= MIN_REGION_PIXELS) {
        regions.push({ x: regionX, y: regionY, width: regionW, height: regionH });
      }
    }
  }

  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    drawRect(overlayData, w, h, r.x, r.y, r.x + r.width - 1, r.y + r.height - 1, COLOR_DIFF_BORDER, DIFF_BORDER_THICKNESS);
    const labelY = Math.max(0, r.y - (7 * FONT_SCALE + LABEL_PADDING * 2) - 2);
    drawNumber(overlayData, w, h, i + 1, r.x, labelY, COLOR_WHITE, COLOR_BG, FONT_SCALE);
  }

  return {
    image: await overlay.getBuffer("image/png"),
    regions,
    changePercent,
    changedPixels,
    totalPixels,
  };
}
