import type { A11yRule } from "../types.js";
import { missingLabelRule } from "./missing-label.js";
import { touchTargetRule } from "./touch-target.js";
import { interactiveLabelsRule } from "./interactive-labels.js";
import { focusOrderRule } from "./focus-order.js";
import { duplicateDescriptionsRule } from "./duplicate-descriptions.js";
import { stateDescriptionRule } from "./state-description.js";

export const ALL_RULES: A11yRule[] = [
  missingLabelRule,
  touchTargetRule,
  interactiveLabelsRule,
  focusOrderRule,
  duplicateDescriptionsRule,
  stateDescriptionRule,
];

const ruleMap = new Map<string, A11yRule>(
  ALL_RULES.map((r) => [r.id, r]),
);

export function getRuleById(id: string): A11yRule | undefined {
  return ruleMap.get(id);
}
