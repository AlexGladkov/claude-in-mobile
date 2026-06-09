import { Jimp } from "jimp";
import { tryLoadSharp } from "./backend.js";
import { DEFAULT_COMPRESS_OPTIONS, type CompressOptions, type CompressResult } from "./types.js";

/**
 * Compress PNG image buffer.
 *  - Resize if larger than max dimensions
 *  - Convert to JPEG with iterative quality reduction if still too large
 *  - Optional `turbo` switch uses Sharp (5-10x faster) when available
 * Returns base64-encoded JPEG.
 */
export async function compressScreenshot(
  pngBuffer: Buffer,
  options: CompressOptions = {},
): Promise<CompressResult> {
  if (!pngBuffer || pngBuffer.length === 0) {
    throw new Error(
      "Screenshot returned empty data (0 bytes). The screen may be off — try press_key('WAKEUP') first, or the device may be disconnected.",
    );
  }

  const opts = { ...DEFAULT_COMPRESS_OPTIONS, ...options };

  if (opts.turbo) {
    const sharp = await tryLoadSharp();
    if (sharp) {
      return compressWithSharp(sharp, pngBuffer, {
        maxWidth: opts.maxWidth!,
        maxHeight: opts.maxHeight!,
        quality: opts.quality!,
        maxSizeBytes: opts.maxSizeBytes!,
      });
    }
    // Sharp not available — fall through to Jimp
  }

  return compressWithJimp(pngBuffer, {
    maxWidth: opts.maxWidth!,
    maxHeight: opts.maxHeight!,
    quality: opts.quality!,
    maxSizeBytes: opts.maxSizeBytes!,
  });
}

interface ResolvedOpts {
  maxWidth: number;
  maxHeight: number;
  quality: number;
  maxSizeBytes: number;
}

async function compressWithJimp(pngBuffer: Buffer, opts: ResolvedOpts): Promise<CompressResult> {
  const image = await Jimp.read(pngBuffer);
  const width = image.width;
  const height = image.height;

  let newWidth = width;
  let newHeight = height;

  if (width > opts.maxWidth || height > opts.maxHeight) {
    const widthRatio = opts.maxWidth / width;
    const heightRatio = opts.maxHeight / height;
    const ratio = Math.min(widthRatio, heightRatio);
    newWidth = Math.round(width * ratio);
    newHeight = Math.round(height * ratio);
  }

  if (newWidth !== width || newHeight !== height) {
    image.resize({ w: newWidth, h: newHeight });
  }

  let quality = opts.quality;
  let jpegBuffer: Buffer;
  let attempts = 0;
  const maxAttempts = 5;

  do {
    jpegBuffer = await image.getBuffer("image/jpeg", { quality });
    if (jpegBuffer.length <= opts.maxSizeBytes) break;
    quality = Math.max(20, quality - 15);
    attempts++;
  } while (attempts < maxAttempts);

  if (jpegBuffer.length > opts.maxSizeBytes) {
    const scaleFactor = Math.sqrt(opts.maxSizeBytes / jpegBuffer.length) * 0.9;
    const smallerWidth = Math.round(newWidth * scaleFactor);
    const smallerHeight = Math.round(newHeight * scaleFactor);

    image.resize({ w: smallerWidth, h: smallerHeight });
    newWidth = smallerWidth;
    newHeight = smallerHeight;
    jpegBuffer = await image.getBuffer("image/jpeg", { quality: 50 });
  }

  return {
    data: jpegBuffer.toString("base64"),
    mimeType: "image/jpeg",
    width: newWidth,
    height: newHeight,
    originalWidth: width,
    originalHeight: height,
  };
}

/**
 * Compress using Sharp (native libvips) — turbo fast path.
 * `sharp` is typed as `any` because it is an optional dependency.
 */
async function compressWithSharp(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sharp: (input: Buffer) => any,
  pngBuffer: Buffer,
  opts: ResolvedOpts,
): Promise<CompressResult> {
  const meta = await sharp(pngBuffer).metadata();
  const originalWidth = meta.width ?? 0;
  const originalHeight = meta.height ?? 0;

  let newWidth = originalWidth;
  let newHeight = originalHeight;

  if (originalWidth > opts.maxWidth || originalHeight > opts.maxHeight) {
    const widthRatio = opts.maxWidth / originalWidth;
    const heightRatio = opts.maxHeight / originalHeight;
    const ratio = Math.min(widthRatio, heightRatio);
    newWidth = Math.round(originalWidth * ratio);
    newHeight = Math.round(originalHeight * ratio);
  }

  let quality = opts.quality;
  let jpegBuffer: Buffer;
  let attempts = 0;
  const maxAttempts = 5;

  do {
    let pipeline = sharp(pngBuffer);
    if (newWidth !== originalWidth || newHeight !== originalHeight) {
      pipeline = pipeline.resize(newWidth, newHeight, { fit: "inside" });
    }
    jpegBuffer = await pipeline.jpeg({ quality }).toBuffer();

    if (jpegBuffer.length <= opts.maxSizeBytes) break;
    quality = Math.max(20, quality - 15);
    attempts++;
  } while (attempts < maxAttempts);

  if (jpegBuffer.length > opts.maxSizeBytes) {
    const scaleFactor = Math.sqrt(opts.maxSizeBytes / jpegBuffer.length) * 0.9;
    newWidth = Math.round(newWidth * scaleFactor);
    newHeight = Math.round(newHeight * scaleFactor);
    jpegBuffer = await sharp(pngBuffer)
      .resize(newWidth, newHeight, { fit: "inside" })
      .jpeg({ quality: 50 })
      .toBuffer();
  }

  return {
    data: jpegBuffer.toString("base64"),
    mimeType: "image/jpeg",
    width: newWidth,
    height: newHeight,
    originalWidth,
    originalHeight,
  };
}
