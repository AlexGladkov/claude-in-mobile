import type { A11yCategory } from "./types.js";

export const RULE_CATEGORIES: Record<string, A11yCategory> = {
  "missing-label": "labels",
  "interactive-labels": "labels",
  "touch-target": "touch-targets",
  "focus-order": "focus",
  "duplicate-descriptions": "states",
  "state-description": "states",
};

export const CATEGORY_LABELS: Record<A11yCategory, string> = {
  labels: "Labels",
  "touch-targets": "Touch Targets",
  focus: "Focus",
  states: "States",
};

export const CATEGORY_ORDER: A11yCategory[] = ["labels", "touch-targets", "focus", "states"];

export function getCategoryForRule(ruleId: string): A11yCategory {
  const cat = RULE_CATEGORIES[ruleId];
  if (!cat) throw new Error(`Unknown rule: ${ruleId}`);
  return cat;
}
