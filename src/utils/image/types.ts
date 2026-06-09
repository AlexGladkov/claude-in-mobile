/**
 * Shared types for image utilities.
 * Kept in a separate module so consumers can `import type` without pulling
 * Jimp / Sharp into their dependency graph.
 */

export interface CompressOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  maxSizeBytes?: number;
  /** When true, use Sharp (native) for faster compression if available. */
  turbo?: boolean;
}

export interface CompressResult {
  data: string;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenDiffResult {
  changePercent: number;
  changedRegion: DiffRegion | null;
  changedPixels: number;
  totalPixels: number;
}

export interface DiffOverlayResult {
  image: Buffer;
  regions: DiffRegion[];
  changePercent: number;
  changedPixels: number;
  totalPixels: number;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface AnnotateResult {
  image: CompressResult;
  elements: Array<{
    index: number;
    label: string;
    clickable: boolean;
    center: { x: number; y: number };
  }>;
}

export const DEFAULT_COMPRESS_OPTIONS: Required<Omit<CompressOptions, "turbo">> & { turbo?: boolean } = {
  maxWidth: 540,
  maxHeight: 960,
  quality: 55,
  maxSizeBytes: 512 * 1024,
};
