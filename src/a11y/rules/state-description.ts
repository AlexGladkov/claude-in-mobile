import type { UiElement } from "../../adb/ui-parser.js";
import type { A11yRule, A11yIssue } from "../types.js";

export const stateDescriptionRule: A11yRule = {
  id: "state-description",
  name: "State Description",
  wcag: "4.1.2",
  severity: "moderate",
  description:
    "Checkable elements (checkboxes, switches, toggles) must have a text label or content description.",
  platforms: ["android", "ios", "desktop"],
  run(elements: UiElement[]): A11yIssue[] {
    const issues: A11yIssue[] = [];

    for (const el of elements) {
      if (!el.checkable) continue;
      if (el.width <= 0 || el.height <= 0) continue;

      const hasText = el.text.trim().length > 0;
      const hasContentDesc = el.contentDesc.trim().length > 0;

      if (!hasText && !hasContentDesc) {
        issues.push({
          ruleId: "state-description",
          wcag: "4.1.2",
          severity: "moderate",
          message:
            "Checkable element has no text or content description to convey its purpose",
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
