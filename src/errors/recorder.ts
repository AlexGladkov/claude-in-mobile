import { MobileError } from "./base.js";

export class RecorderAlreadyActiveError extends MobileError {
  constructor(currentName: string) {
    super(
      `Recording already in progress: "${currentName}". Use recorder(action:'stop') first.`,
      "RECORDER_ALREADY_ACTIVE"
    );
  }
}

export class RecorderNotActiveError extends MobileError {
  constructor() {
    super(
      "No recording in progress. Use recorder(action:'start') to begin.",
      "RECORDER_NOT_ACTIVE"
    );
  }
}

export class ScenarioNotFoundError extends MobileError {
  constructor(name: string, platform: string) {
    super(
      `Scenario "${name}" not found for platform "${platform}". Use recorder(action:'list') to see saved scenarios.`,
      "SCENARIO_NOT_FOUND"
    );
  }
}

export class ScenarioExistsError extends MobileError {
  constructor(name: string, platform: string) {
    super(
      `Scenario "${name}" already exists for platform "${platform}". Use overwrite:true or recorder(action:'delete').`,
      "SCENARIO_EXISTS"
    );
  }
}

export class ScenarioCorruptedError extends MobileError {
  constructor(name: string, reason: string) {
    super(
      `Scenario "${name}" corrupted: ${reason}. Delete and re-record.`,
      "SCENARIO_CORRUPTED"
    );
  }
}
