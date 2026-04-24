import type { UiElement } from "../../adb/ui-parser.js";
import type { A11yRule, A11yIssue } from "../types.js";

const CONTAINER_PATTERNS = ["Layout", "ViewGroup", "ScrollView"];

function isContainer(className: string): boolean {
  return CONTAINER_PATTERNS.some((p) => className.includes(p));
}

export const missingLabelRule: A11yRule = {
  id: "missing-label",
  name: "Missing Label",
  wcag: "1.1.1",
  severity: "critical",
  description:
    "Clickable elements must have a text label or content description for screen readers.",
  platforms: ["android", "ios", "desktop"],
  run(elements: UiElement[]): A11yIssue[] {
    const issues: A11yIssue[] = [];

    for (const el of elements) {
      if (!el.clickable) continue;
      if (isContainer(el.className)) continue;
      // Invisible elements are skipped
      if (el.width <= 0 || el.height <= 0) continue;

      const hasContentDesc = el.contentDesc.trim().length > 0;
      const hasText = el.text.trim().length > 0;

      // Password elements: contentDesc still required, but missing text is ok
      if (el.password) {
        if (!hasContentDesc) {
          issues.push({
            ruleId: "missing-label",
            wcag: "1.1.1",
            severity: "critical",
            message:
              "Password field has no content description for screen readers",
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
        continue;
      }

      if (!hasText && !hasContentDesc) {
        issues.push({
          ruleId: "missing-label",
          wcag: "1.1.1",
          severity: "critical",
          message: "Clickable element has no text or content description",
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
