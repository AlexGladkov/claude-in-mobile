import { MobileError } from "./base.js";

export class A11yAuditError extends MobileError {
  constructor(message: string) {
    super(message, "A11Y_AUDIT_ERROR");
  }
}

export class A11yRuleNotFoundError extends MobileError {
  constructor(ruleId: string) {
    super(
      `Accessibility rule "${ruleId}" not found. Use accessibility(action:'rules') to see available rules.`,
      "A11Y_RULE_NOT_FOUND"
    );
  }
}
