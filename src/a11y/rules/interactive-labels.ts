import type { UiElement } from "../../adb/ui-parser.js";
import type { A11yRule, A11yIssue } from "../types.js";

export const interactiveLabelsRule: A11yRule = {
  id: "interactive-labels",
  name: "Interactive Image Labels",
  wcag: "4.1.2",
  severity: "critical",
  description:
    "Clickable ImageView and ImageButton elements must have a content description.",
  platforms: ["android", "ios", "desktop"],
  run(elements: UiElement[]): A11yIssue[] {
    const issues: A11yIssue[] = [];

    for (const el of elements) {
      if (!el.clickable) continue;
      if (el.width <= 0 || el.height <= 0) continue;

      const isImage =
        el.className.includes("ImageView") ||
        el.className.includes("ImageButton");
      if (!isImage) continue;

      if (el.contentDesc.trim().length === 0) {
        issues.push({
          ruleId: "interactive-labels",
          wcag: "4.1.2",
          severity: "critical",
          message:
            "Clickable image element has no content description for screen readers",
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
