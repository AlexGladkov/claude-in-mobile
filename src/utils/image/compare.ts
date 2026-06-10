import { Jimp } from "jimp";
import type { DiffRegion, ScreenDiffResult } from "./types.js";

/**
 * Compare two screenshot buffers pixel-by-pixel.
 * Returns change percentage and bounding box of changed region.
 * Samples every 2nd pixel for speed.
 */
export async function compareScreenshots(
  prev: Buffer,
  next: Buffer,
  threshold = 30,
): Promise<ScreenDiffResult> {
  const prevImg = await Jimp.read(prev);
  const nextImg = await Jimp.read(next);

  if (prevImg.width !== nextImg.width || prevImg.height !== nextImg.height) {
    return {
      changePercent: 100,
      changedRegion: { x: 0, y: 0, width: nextImg.width, height: nextImg.height },
      changedPixels: nextImg.width * nextImg.height,
      totalPixels: nextImg.width * nextImg.height,
    };
  }

  const w = prevImg.width;
  const h = prevImg.height;
  const prevData = prevImg.bitmap.data as Buffer;
  const nextData = nextImg.bitmap.data as Buffer;
  const thresholdSum = threshold * 3;

  let changedPixels = 0;
  let sampledPixels = 0;
  let minX = w, minY = h, maxX = 0, maxY = 0;

  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      sampledPixels++;
      const offset = (y * w + x) * 4;
      const dr = Math.abs(prevData[offset] - nextData[offset]);
      const dg = Math.abs(prevData[offset + 1] - nextData[offset + 1]);
      const db = Math.abs(prevData[offset + 2] - nextData[offset + 2]);

      if (dr + dg + db > thresholdSum) {
        changedPixels++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  const changePercent = sampledPixels > 0
    ? (changedPixels / sampledPixels) * 100
    : 0;

  const changedRegion = changedPixels > 0
    ? { x: minX, y: minY, width: maxX - minX + 2, height: maxY - minY + 2 }
    : null;

  return {
    changePercent: Math.round(changePercent * 10) / 10,
    changedRegion,
    changedPixels,
    totalPixels: sampledPixels,
  };
}

/**
 * Crop a region from a PNG buffer with padding.
 * Returns the cropped image as a PNG buffer.
 */
export async function cropRegion(
  pngBuffer: Buffer,
  region: DiffRegion,
  padding = 20,
): Promise<Buffer> {
  const image = await Jimp.read(pngBuffer);
  const x = Math.max(0, region.x - padding);
  const y = Math.max(0, region.y - padding);
  const w = Math.min(image.width - x, region.width + padding * 2);
  const h = Math.min(image.height - y, region.height + padding * 2);

  image.crop({ x, y, w, h });
  return await image.getBuffer("image/png");
}
