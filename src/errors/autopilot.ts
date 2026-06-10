import { MobileError } from "./base.js";

export class ExplorationNotFoundError extends MobileError {
  constructor(id: string) {
    super(
      `Exploration "${id}" not found. Use autopilot(action:'explore') to create one.`,
      "EXPLORATION_NOT_FOUND"
    );
  }
}

export class ExplorationLimitError extends MobileError {
  constructor(detail: string) {
    super(
      `Exploration limit: ${detail}`,
      "EXPLORATION_LIMIT"
    );
  }
}

export class HealingFailedError extends MobileError {
  constructor(detail: string) {
    super(
      `Self-healing failed: ${detail}`,
      "HEALING_FAILED"
    );
  }
}

export class TestGenerationError extends MobileError {
  constructor(detail: string) {
    super(
      `Test generation failed: ${detail}`,
      "TEST_GENERATION_ERROR"
    );
  }
}
