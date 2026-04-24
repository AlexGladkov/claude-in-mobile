import type { UiElement } from "../../adb/ui-parser.js";
import type { A11yRule, A11yIssue } from "../types.js";

const MIN_TARGET_SIZE = 48;

export const touchTargetRule: A11yRule = {
  id: "touch-target",
  name: "Touch Target Size",
  wcag: "2.5.8",
  severity: "serious",
  description: `Interactive elements must have a minimum touch target size of ${MIN_TARGET_SIZE}x${MIN_TARGET_SIZE}dp.`,
  platforms: ["android", "ios", "desktop"],
  run(elements: UiElement[]): A11yIssue[] {
    const issues: A11yIssue[] = [];

    for (const el of elements) {
      if (!el.clickable) continue;
      // Skip invisible elements
      if (el.width <= 0 || el.height <= 0) continue;

      if (el.width < MIN_TARGET_SIZE || el.height < MIN_TARGET_SIZE) {
        issues.push({
          ruleId: "touch-target",
          wcag: "2.5.8",
          severity: "serious",
          message: `Touch target ${el.width}x${el.height} is smaller than minimum ${MIN_TARGET_SIZE}x${MIN_TARGET_SIZE}`,
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

    return issues;
  },
};
