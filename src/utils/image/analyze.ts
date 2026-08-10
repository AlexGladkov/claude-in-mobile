import { Jimp } from "jimp";

export interface UniformFrameResult {
  /** True when almost every sampled pixel matches the frame's mean color. */
  uniform: boolean;
  /** Fraction (0..1) of sampled pixels within tolerance of the mean color. */
  coverage: number;
  /** True when the uniform color is essentially black (secure/blank frame). */
  nearBlack: boolean;
  /** Mean perceived luminance 0..255 of the sampled pixels. */
  meanLuminance: number;
}

const TOLERANCE = 12; // per-channel delta still considered "the same color"
const UNIFORM_COVERAGE = 0.985; // ≥98.5% of pixels uniform → single-color frame
const NEAR_BLACK_LUMA = 16;
const MAX_SAMPLES = 4096; // cap work regardless of resolution

/**
 * Detect whether a PNG/JPEG frame is essentially a single flat color — the
 * signature of an all-black `screencap` returned for FLAG_SECURE windows, or
 * of a blank/GPU-failed capture. Cheap: samples on a stride so cost is bounded
 * by MAX_SAMPLES rather than resolution.
 */
export async function detectUniformFrame(buffer: Buffer): Promise<UniformFrameResult> {
  const img = await Jimp.read(buffer);
  const { data } = img.bitmap;
  const w = img.width;
  const h = img.height;
  const totalPixels = w * h;

  // Choose a stride that keeps the sample count near MAX_SAMPLES.
  const stride = Math.max(1, Math.floor(Math.sqrt(totalPixels / MAX_SAMPLES)));

  let sampled = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  // First pass: mean color.
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const o = (y * w + x) * 4;
      sumR += data[o];
      sumG += data[o + 1];
      sumB += data[o + 2];
      sampled++;
    }
  }
  if (sampled === 0) {
    return { uniform: false, coverage: 0, nearBlack: false, meanLuminance: 0 };
  }

  const meanR = sumR / sampled;
  const meanG = sumG / sampled;
  const meanB = sumB / sampled;

  // Second pass: how many samples sit within tolerance of the mean.
  let within = 0;
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const o = (y * w + x) * 4;
      if (
        Math.abs(data[o] - meanR) <= TOLERANCE &&
        Math.abs(data[o + 1] - meanG) <= TOLERANCE &&
        Math.abs(data[o + 2] - meanB) <= TOLERANCE
      ) {
        within++;
      }
    }
  }

  const coverage = within / sampled;
  const meanLuminance = 0.299 * meanR + 0.587 * meanG + 0.114 * meanB;

  return {
    uniform: coverage >= UNIFORM_COVERAGE,
    coverage: Math.round(coverage * 1000) / 1000,
    nearBlack: meanLuminance < NEAR_BLACK_LUMA,
    meanLuminance: Math.round(meanLuminance * 10) / 10,
  };
}
