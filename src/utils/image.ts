/**
 * Image utilities facade.
 *
 * The implementation lives in `./image/` — this module re-exports the public
 * surface so existing imports `from "../utils/image.js"` keep working.
 *
 * Split (D9.4):
 *   - image/types.ts     — shared types & defaults
 *   - image/backend.ts   — optional Sharp (libvips) loader
 *   - image/encode.ts    — buffer-only encoding helpers
 *   - image/compress.ts  — JPEG compression (Jimp + Sharp turbo path)
 *   - image/compare.ts   — pixel diff + crop
 *   - image/drawing.ts   — pixel buffer primitives + bitmap font
 *   - image/overlay.ts   — visual regression diff overlay
 *   - image/annotate.ts  — UI element annotation
 */

export type {
  CompressOptions,
  CompressResult,
  DiffRegion,
  ScreenDiffResult,
  DiffOverlayResult,
  AnnotateResult,
} from "./image/index.js";

export {
  compressScreenshot,
  toBase64Png,
  compareScreenshots,
  cropRegion,
  generateDiffOverlay,
  annotateScreenshot,
} from "./image/index.js";
