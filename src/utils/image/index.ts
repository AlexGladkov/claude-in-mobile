/**
 * Barrel for image utilities. Public API surface for `src/utils/image.ts`.
 */

export type {
  CompressOptions,
  CompressResult,
  DiffRegion,
  ScreenDiffResult,
  DiffOverlayResult,
  AnnotateResult,
} from "./types.js";

export { compressScreenshot } from "./compress.js";
export { toBase64Png } from "./encode.js";
export { compareScreenshots, cropRegion } from "./compare.js";
export { generateDiffOverlay } from "./overlay.js";
export { annotateScreenshot } from "./annotate.js";
