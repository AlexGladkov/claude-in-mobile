import type { UiElement } from "../../adb/ui-parser.js";
import type { A11yRule, A11yRuleRunResult, A11yIssue } from "../types.js";

export const focusOrderRule: A11yRule = {
  id: "focus-order",
  name: "Focus Order",
  wcag: "2.1.1",
  severity: "serious",
  description:
    "Clickable elements should be focusable so they can be reached via keyboard or switch navigation.",
  platforms: ["android", "ios", "desktop"],
  run(elements: UiElement[]): A11yRuleRunResult {
    const issues: A11yIssue[] = [];
    let applicableCount = 0;

    for (const el of elements) {
      if (!el.clickable) continue;
      if (el.width <= 0 || el.height <= 0) continue;

      applicableCount++;

      if (!el.focusable) {
        issues.push({
          ruleId: "focus-order",
          wcag: "2.1.1",
          severity: "serious",
          message: "Clickable element is not focusable for keyboard/switch navigation",
          element: {
            index: el.index,
            className: el.className,
            resourceId: el.resourceId,
            bounds: el.bounds,
            centerX: el.centerX,
            centerY: el.centerY,
          },
        });
      }
    }

    return { applicableCount, issues };
  },
};
