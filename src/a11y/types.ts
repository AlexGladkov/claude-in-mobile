import type { UiElement } from "../ui-tree/ui-parser.js";

export type A11ySeverity = "critical" | "serious" | "moderate" | "minor";
export type WcagLevel = "A" | "AA" | "AAA";

export interface A11yIssue {
  ruleId: string;
  wcag: string;
  severity: A11ySeverity;
  /** Must NOT contain raw element text/contentDesc — may contain PII. Use static messages only. */
  message: string;
  element: {
    index: number;
    className: string;
    resourceId: string;
    bounds: { x1: number; y1: number; x2: number; y2: number };
    centerX: number;
    centerY: number;
  };
}

export interface A11yRule {
  id: string;
  name: string;
  wcag: string;
  severity: A11ySeverity;
  description: string;
  platforms: Array<"android" | "ios" | "desktop">;
  run: (elements: UiElement[]) => A11yRuleRunResult;
}

export interface A11yReport {
  platform: string;
  timestamp: string;
  score: number;
  totalElements: number;
  issueCount: { critical: number; serious: number; moderate: number; minor: number; total: number };
  issues: A11yIssue[];
  passedRules: string[];
  standard: string;
}

export type A11yCategory = "labels" | "touch-targets" | "focus" | "states";

export interface A11yRuleRunResult {
  applicableCount: number;
  issues: A11yIssue[];
}

export interface A11yRuleResult {
  ruleId: string;
  category: A11yCategory;
  applicableCount: number;
  passedCount: number;
  issues: A11yIssue[];
  passRate: number;
}

export interface A11yCategoryScore {
  category: A11yCategory;
  label: string;
  score: number;
  applicableCount: number;
  issueCount: number;
  rules: A11yRuleResult[];
}

export interface A11yActionItem {
  ruleId: string;
  category: A11yCategory;
  severity: A11ySeverity;
  count: number;
  message: string;
}

export interface A11yDetailedReport extends A11yReport {
  categories: A11yCategoryScore[];
  ruleResults: A11yRuleResult[];
  actionItems: A11yActionItem[];
}
