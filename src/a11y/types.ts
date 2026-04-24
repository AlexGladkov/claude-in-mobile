import type { UiElement } from "../adb/ui-parser.js";

export type A11ySeverity = "critical" | "serious" | "moderate" | "minor";
export type WcagLevel = "A" | "AA" | "AAA";

export interface A11yIssue {
  ruleId: string;
  wcag: string;
  severity: A11ySeverity;
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
  run: (elements: UiElement[]) => A11yIssue[];
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
