import { MobileError } from "./base.js";

export class PerfBaselineNotFoundError extends MobileError {
  constructor(name: string, platform: string) {
    super(
      `Performance baseline "${name}" not found for ${platform}. Use performance(action:'baseline') to create one.`,
      "PERF_BASELINE_NOT_FOUND"
    );
  }
}

export class PerfBaselineExistsError extends MobileError {
  constructor(name: string) {
    super(
      `Performance baseline "${name}" already exists. Use overwrite:true to replace.`,
      "PERF_BASELINE_EXISTS"
    );
  }
}

export class PerfCollectionError extends MobileError {
  constructor(platform: string, detail: string) {
    super(
      `Failed to collect performance metrics on ${platform}: ${detail}`,
      "PERF_COLLECTION_ERROR"
    );
  }
}
