import { MobileError } from "./base.js";

export class BaselineNotFoundError extends MobileError {
  constructor(name: string, platform: string) {
    super(
      `Baseline "${name}" not found for platform "${platform}". Use visual(action:'baseline_save') to create one.`,
      "BASELINE_NOT_FOUND"
    );
  }
}

export class BaselineExistsError extends MobileError {
  constructor(name: string, platform: string) {
    super(
      `Baseline "${name}" already exists for platform "${platform}". Use overwrite:true or visual(action:'baseline_update').`,
      "BASELINE_EXISTS"
    );
  }
}

export class VisualMismatchError extends MobileError {
  constructor(name: string, platform: string, diffPercent: number, threshold: number) {
    super(
      `Visual mismatch: "${name}" (${platform}) — ${diffPercent.toFixed(1)}% diff exceeds ${threshold}% threshold.`,
      "VISUAL_MISMATCH"
    );
  }
}

export class BaselineCorruptedError extends MobileError {
  constructor(name: string, reason: string) {
    super(
      `Baseline "${name}" corrupted: ${reason}. Use visual(action:'baseline_update') to recreate.`,
      "BASELINE_CORRUPTED"
    );
  }
}
