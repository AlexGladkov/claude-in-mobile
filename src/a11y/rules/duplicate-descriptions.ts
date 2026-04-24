import type { UiElement } from "../../adb/ui-parser.js";
import type { A11yRule, A11yIssue } from "../types.js";

export const duplicateDescriptionsRule: A11yRule = {
  id: "duplicate-descriptions",
  name: "Duplicate Descriptions",
  wcag: "1.3.1",
  severity: "moderate",
  description:
    "Multiple elements with identical content descriptions confuse screen reader users.",
  platforms: ["android", "ios", "desktop"],
  run(elements: UiElement[]): A11yIssue[] {
    // Group by non-empty contentDesc, exclude short (<=1 char) descriptions
    const groups = new Map<string, UiElement[]>();

    for (const el of elements) {
      const desc = el.contentDesc.trim();
      if (desc.length <= 1) continue;
      if (el.width <= 0 || el.height <= 0) continue;

      const existing = groups.get(desc);
      if (existing) {
        existing.push(el);
      } else {
        groups.set(desc, [el]);
      }
    }

    const issues: A11yIssue[] = [];

    for (const [desc, els] of groups) {
      if (els.length <= 1) continue;

      // Report each duplicate element
      for (const el of els) {
        issues.push({
          ruleId: "duplicate-descriptions",
          wcag: "1.3.1",
          severity: "moderate",
          message: `Duplicate content description "${desc}" shared by ${els.length} elements`,
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
