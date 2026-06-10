import { MobileError } from "./base.js";

export class UnknownActionError extends MobileError {
  constructor(tool: string, action: string, validActions: string[]) {
    super(
      `Unknown action "${action}" for ${tool}. Valid: ${validActions.join(", ")}`,
      "UNKNOWN_ACTION"
    );
  }
}

export class ValidationError extends MobileError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
  }
}
