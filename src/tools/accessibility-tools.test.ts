import { describe, it, expect } from "vitest";
import type { UiElement } from "../adb/ui-parser.js";
import type { ToolContext } from "./context.js";
import { accessibilityTools } from "./accessibility-tools.js";
import { missingLabelRule } from "../a11y/rules/missing-label.js";
import { touchTargetRule } from "../a11y/rules/touch-target.js";
import { interactiveLabelsRule } from "../a11y/rules/interactive-labels.js";
import { focusOrderRule } from "../a11y/rules/focus-order.js";
import { duplicateDescriptionsRule } from "../a11y/rules/duplicate-descriptions.js";
import { stateDescriptionRule } from "../a11y/rules/state-description.js";
import { calculateScore, calculateRelativeScore, calculateCategoryScores, generateActionItems } from "../a11y/score.js";
import { formatAuditReport, formatAuditSummary, formatCategoryBreakdown, formatActionItems } from "../a11y/formatter.js";
import type { A11yReport, A11yRuleResult, A11yCategoryScore } from "../a11y/types.js";
import { getCategoryForRule, RULE_CATEGORIES, CATEGORY_ORDER } from "../a11y/categories.js";
import { ValidationError, A11yRuleNotFoundError } from "../errors.js";

// ── Helpers ──

function makeElement(overrides: Partial<UiElement> = {}): UiElement {
  return {
    index: 0,
    resourceId: "",
    className: "android.widget.Button",
    packageName: "com.test",
    text: "",
    contentDesc: "",
    checkable: false,
    checked: false,
    clickable: false,
    enabled: true,
    focusable: true,
    focused: false,
    scrollable: false,
    longClickable: false,
    password: false,
    selected: false,
    bounds: { x1: 0, y1: 0, x2: 100, y2: 100 },
    centerX: 50,
    centerY: 50,
    width: 100,
    height: 100,
    ...overrides,
  };
}

// Mock getUiElements by providing a mock context with deviceManager
let mockElements: UiElement[] = [];

function mockCtx(): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: () => "android",
      getUiHierarchyAsync: async () => {
        // Build minimal XML from mockElements
        const nodes = mockElements
          .map(
            (el) =>
              `<node index="${el.index}" text="${el.text}" resource-id="${el.resourceId}" ` +
              `class="${el.className}" package="${el.packageName}" ` +
              `content-desc="${el.contentDesc}" checkable="${el.checkable}" ` +
              `checked="${el.checked}" clickable="${el.clickable}" ` +
              `enabled="${el.enabled}" focusable="${el.focusable}" ` +
              `focused="${el.focused}" scrollable="${el.scrollable}" ` +
              `long-clickable="${el.longClickable}" password="${el.password}" ` +
              `selected="${el.selected}" ` +
              `bounds="[${el.bounds.x1},${el.bounds.y1}][${el.bounds.x2},${el.bounds.y2}]" />`,
          )
          .join("\n");
        return `<hierarchy>${nodes}</hierarchy>`;
      },
      cleanup: async () => {},
    } as any,
    getCachedElements: () => [],
    setCachedElements: () => {},
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: async () => "",
    getElementsForPlatform: async () => [],
    iosTreeToUiElements: () => [],
    formatIOSUITree: () => "",
    platformParam: { type: "string", enum: ["android"], description: "" },
    handleTool: async () => ({ text: "ok" }),
  };
}

// ── Rule tests ──

describe("missing-label rule", () => {
  it("detects clickable element without label", () => {
    const el = makeElement({ clickable: true, text: "", contentDesc: "" });
    const { issues } = missingLabelRule.run([el]);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe("missing-label");
    expect(issues[0].severity).toBe("critical");
  });

  it("passes when element has text", () => {
    const el = makeElement({ clickable: true, text: "Login" });
    const { issues } = missingLabelRule.run([el]);
    expect(issues).toHaveLength(0);
  });

  it("passes when element has contentDesc", () => {
    const el = makeElement({ clickable: true, contentDesc: "Menu" });
    const { issues } = missingLabelRule.run([el]);
    expect(issues).toHaveLength(0);
  });

  it("skips non-clickable elements", () => {
    const el = makeElement({ clickable: false, text: "", contentDesc: "" });
    const { issues } = missingLabelRule.run([el]);
    expect(issues).toHaveLength(0);
  });

  it("skips container classes", () => {
    const el = makeElement({
      clickable: true,
      text: "",
      contentDesc: "",
      className: "android.widget.LinearLayout",
    });
    const { issues } = missingLabelRule.run([el]);
    expect(issues).toHaveLength(0);
  });

  it("handles password elements — missing contentDesc is flagged", () => {
    const el = makeElement({
      clickable: true,
      password: true,
      text: "",
      contentDesc: "",
    });
    const { issues } = missingLabelRule.run([el]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("Password");
  });

  it("handles password elements — has contentDesc passes", () => {
    const el = makeElement({
      clickable: true,
      password: true,
      text: "",
      contentDesc: "Password field",
    });
    const { issues } = missingLabelRule.run([el]);
    expect(issues).toHaveLength(0);
  });
});

describe("touch-target rule", () => {
  it("detects small touch target", () => {
    const el = makeElement({
      clickable: true,
      width: 30,
      height: 30,
      bounds: { x1: 0, y1: 0, x2: 30, y2: 30 },
    });
    const { issues } = touchTargetRule.run([el]);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe("touch-target");
    expect(issues[0].message).toContain("30x30");
  });

  it("passes when target is large enough", () => {
    const el = makeElement({
      clickable: true,
      width: 48,
      height: 48,
      bounds: { x1: 0, y1: 0, x2: 48, y2: 48 },
    });
    const { issues } = touchTargetRule.run([el]);
    expect(issues).toHaveLength(0);
  });

  it("skips invisible elements (0 size)", () => {
    const el = makeElement({
      clickable: true,
      width: 0,
      height: 0,
      bounds: { x1: 0, y1: 0, x2: 0, y2: 0 },
    });
    const { issues } = touchTargetRule.run([el]);
    expect(issues).toHaveLength(0);
  });
});

describe("interactive-labels rule", () => {
  it("detects ImageButton without contentDesc", () => {
    const el = makeElement({
      clickable: true,
      className: "android.widget.ImageButton",
      contentDesc: "",
    });
    const { issues } = interactiveLabelsRule.run([el]);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe("interactive-labels");
  });

  it("passes ImageView with contentDesc", () => {
    const el = makeElement({
      clickable: true,
      className: "android.widget.ImageView",
      contentDesc: "Profile picture",
    });
    const { issues } = interactiveLabelsRule.run([el]);
    expect(issues).toHaveLength(0);
  });

  it("skips non-image clickable elements", () => {
    const el = makeElement({
      clickable: true,
      className: "android.widget.Button",
      contentDesc: "",
    });
    const { issues } = interactiveLabelsRule.run([el]);
    expect(issues).toHaveLength(0);
  });
});

describe("focus-order rule", () => {
  it("detects clickable but not focusable", () => {
    const el = makeElement({ clickable: true, focusable: false });
    const { issues } = focusOrderRule.run([el]);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe("focus-order");
  });

  it("passes when clickable and focusable", () => {
    const el = makeElement({ clickable: true, focusable: true });
    const { issues } = focusOrderRule.run([el]);
    expect(issues).toHaveLength(0);
  });
});

describe("duplicate-descriptions rule", () => {
  it("detects duplicate contentDesc", () => {
    const el1 = makeElement({ index: 0, contentDesc: "Star" });
    const el2 = makeElement({ index: 1, contentDesc: "Star" });
    const { issues } = duplicateDescriptionsRule.run([el1, el2]);
    expect(issues).toHaveLength(2);
    expect(issues[0].ruleId).toBe("duplicate-descriptions");
  });

  it("skips short contentDesc (<=1 char)", () => {
    const el1 = makeElement({ index: 0, contentDesc: "X" });
    const el2 = makeElement({ index: 1, contentDesc: "X" });
    const { issues } = duplicateDescriptionsRule.run([el1, el2]);
    expect(issues).toHaveLength(0);
  });

  it("passes when all descriptions are unique", () => {
    const el1 = makeElement({ index: 0, contentDesc: "Edit" });
    const el2 = makeElement({ index: 1, contentDesc: "Delete" });
    const { issues } = duplicateDescriptionsRule.run([el1, el2]);
    expect(issues).toHaveLength(0);
  });
});

describe("state-description rule", () => {
  it("detects checkable without label", () => {
    const el = makeElement({
      checkable: true,
      text: "",
      contentDesc: "",
    });
    const { issues } = stateDescriptionRule.run([el]);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe("state-description");
  });

  it("passes when checkable has text", () => {
    const el = makeElement({
      checkable: true,
      text: "Enable notifications",
    });
    const { issues } = stateDescriptionRule.run([el]);
    expect(issues).toHaveLength(0);
  });
});

// ── Score tests ──

describe("calculateScore", () => {
  it("returns 100 for zero issues", () => {
    expect(calculateScore([])).toBe(100);
  });

  it("returns 85 for one critical issue", () => {
    const { issues } = missingLabelRule.run([
      makeElement({ clickable: true, text: "", contentDesc: "" }),
    ]);
    expect(calculateScore(issues)).toBe(85);
  });

  it("correctly calculates for multiple issues", () => {
    // 1 critical (15) + 1 serious (8) = 23 penalty => score 77
    const critical = missingLabelRule.run([
      makeElement({ clickable: true, text: "", contentDesc: "" }),
    ]);
    const serious = touchTargetRule.run([
      makeElement({
        clickable: true,
        width: 20,
        height: 20,
        bounds: { x1: 0, y1: 0, x2: 20, y2: 20 },
      }),
    ]);
    expect(calculateScore([...critical.issues, ...serious.issues])).toBe(77);
  });

  it("clamps to 0 for many issues", () => {
    const elements = Array.from({ length: 20 }, (_, i) =>
      makeElement({ index: i, clickable: true, text: "", contentDesc: "" }),
    );
    const { issues } = missingLabelRule.run(elements);
    expect(calculateScore(issues)).toBe(0);
  });
});

// ── Formatter tests ──

describe("formatAuditReport", () => {
  const baseReport: A11yReport = {
    platform: "android",
    timestamp: "2026-04-24T12:00:00.000Z",
    score: 100,
    totalElements: 10,
    issueCount: { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 },
    issues: [],
    passedRules: ["missing-label", "touch-target"],
    standard: "AA",
  };

  it("outputs PASS when score is 100", () => {
    const text = formatAuditReport(baseReport);
    expect(text).toContain("A11Y AUDIT: PASS");
    expect(text).toContain("score: 100/100");
  });

  it("outputs FAIL when score < 100", () => {
    const report: A11yReport = {
      ...baseReport,
      score: 85,
      issueCount: { critical: 1, serious: 0, moderate: 0, minor: 0, total: 1 },
      issues: [
        {
          ruleId: "missing-label",
          wcag: "1.1.1",
          severity: "critical",
          message: "Clickable element has no text or content description",
          element: {
            index: 0,
            className: "android.widget.ImageButton",
            resourceId: "com.test:id/btn_menu",
            bounds: { x1: 0, y1: 0, x2: 56, y2: 120 },
            centerX: 28,
            centerY: 60,
          },
        },
      ],
    };
    const text = formatAuditReport(report);
    expect(text).toContain("A11Y AUDIT: FAIL");
    expect(text).toContain("CRITICAL:");
    expect(text).toContain("missing-label");
    expect(text).toContain("WCAG 1.1.1");
  });

  it("uses compact format", () => {
    const report: A11yReport = {
      ...baseReport,
      score: 85,
      issueCount: { critical: 1, serious: 0, moderate: 0, minor: 0, total: 1 },
      issues: [
        {
          ruleId: "missing-label",
          wcag: "1.1.1",
          severity: "critical",
          message: "A long description that should not appear",
          element: {
            index: 0,
            className: "android.widget.Button",
            resourceId: "",
            bounds: { x1: 0, y1: 0, x2: 100, y2: 100 },
            centerX: 50,
            centerY: 50,
          },
        },
      ],
    };
    const text = formatAuditReport(report, { compact: true });
    expect(text).not.toContain("A long description that should not appear");
    expect(text).toContain("missing-label");
  });

  it("redacts password elements", () => {
    const report: A11yReport = {
      ...baseReport,
      score: 85,
      issueCount: { critical: 1, serious: 0, moderate: 0, minor: 0, total: 1 },
      issues: [
        {
          ruleId: "missing-label",
          wcag: "1.1.1",
          severity: "critical",
          message: "test",
          element: {
            index: 5,
            className: "android.widget.EditText",
            resourceId: "password_field",
            bounds: { x1: 0, y1: 0, x2: 100, y2: 100 },
            centerX: 50,
            centerY: 50,
          },
        },
      ],
    };
    const text = formatAuditReport(report, {
      passwordIndices: new Set([5]),
    });
    expect(text).toContain("[REDACTED]");
  });
});

describe("formatAuditSummary", () => {
  it("outputs short PASS summary", () => {
    const report: A11yReport = {
      platform: "android",
      timestamp: "2026-04-24T12:00:00.000Z",
      score: 100,
      totalElements: 10,
      issueCount: { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 },
      issues: [],
      passedRules: ["missing-label"],
      standard: "AA",
    };
    const text = formatAuditSummary(report);
    expect(text).toContain("A11Y: PASS");
    expect(text).toContain("score: 100/100");
    expect(text).not.toContain("CRITICAL");
  });
});

// ── Handler integration tests ──

describe("accessibility_audit handler", () => {
  it("runs audit and returns formatted output", async () => {
    mockElements = [
      makeElement({ index: 0, clickable: true, text: "Login", focusable: true }),
      makeElement({ index: 1, clickable: true, text: "", contentDesc: "", focusable: true }),
    ];

    const handler = accessibilityTools.find(
      (t) => t.tool.name === "accessibility_audit",
    )!.handler;
    const ctx = mockCtx();
    const result = (await handler({}, ctx)) as { text: string; isError?: boolean };

    expect(result.text).toContain("A11Y AUDIT:");
    expect(result.text).toContain("missing-label");
    expect(result.isError).toBe(true);
  });

  it("returns PASS when no issues", async () => {
    mockElements = [
      makeElement({ index: 0, clickable: true, text: "OK", focusable: true }),
    ];

    const handler = accessibilityTools.find(
      (t) => t.tool.name === "accessibility_audit",
    )!.handler;
    const ctx = mockCtx();
    const result = (await handler({}, ctx)) as { text: string; isError?: boolean };

    expect(result.text).toContain("PASS");
    expect(result.isError).toBeUndefined();
  });
});

describe("accessibility_check handler", () => {
  it("checks a specific element by text", async () => {
    mockElements = [
      makeElement({ index: 0, clickable: true, text: "Login", focusable: true }),
      makeElement({ index: 1, clickable: true, text: "", contentDesc: "", focusable: true }),
    ];

    const handler = accessibilityTools.find(
      (t) => t.tool.name === "accessibility_check",
    )!.handler;
    const ctx = mockCtx();
    const result = (await handler({ text: "Login" }, ctx)) as { text: string };

    expect(result.text).toContain("PASS");
  });

  it("throws when no criteria provided", async () => {
    mockElements = [];
    const handler = accessibilityTools.find(
      (t) => t.tool.name === "accessibility_check",
    )!.handler;
    const ctx = mockCtx();
    await expect(handler({}, ctx)).rejects.toThrow(ValidationError);
  });
});

describe("accessibility_summary handler", () => {
  it("returns short summary", async () => {
    mockElements = [
      makeElement({ index: 0, clickable: true, text: "OK", focusable: true }),
    ];

    const handler = accessibilityTools.find(
      (t) => t.tool.name === "accessibility_summary",
    )!.handler;
    const ctx = mockCtx();
    const result = (await handler({}, ctx)) as { text: string };

    expect(result.text).toContain("A11Y:");
    expect(result.text).toContain("Passed:");
  });
});

describe("accessibility_rules handler", () => {
  it("lists all rules", async () => {
    const handler = accessibilityTools.find(
      (t) => t.tool.name === "accessibility_rules",
    )!.handler;
    const ctx = mockCtx();
    const result = (await handler({}, ctx)) as { text: string };

    expect(result.text).toContain("Accessibility rules:");
    expect(result.text).toContain("missing-label");
    expect(result.text).toContain("touch-target");
  });

  it("shows detail for one rule", async () => {
    const handler = accessibilityTools.find(
      (t) => t.tool.name === "accessibility_rules",
    )!.handler;
    const ctx = mockCtx();
    const result = (await handler({ ruleId: "missing-label" }, ctx)) as {
      text: string;
    };

    expect(result.text).toContain("Rule: missing-label");
    expect(result.text).toContain("WCAG: 1.1.1");
  });

  it("throws for unknown rule", async () => {
    const handler = accessibilityTools.find(
      (t) => t.tool.name === "accessibility_rules",
    )!.handler;
    const ctx = mockCtx();
    await expect(handler({ ruleId: "nonexistent" }, ctx)).rejects.toThrow(
      A11yRuleNotFoundError,
    );
  });
});

// ── Input validation tests ──

describe("input validation", () => {
  it("rejects invalid standard", async () => {
    mockElements = [];
    const handler = accessibilityTools.find(
      (t) => t.tool.name === "accessibility_audit",
    )!.handler;
    const ctx = mockCtx();
    await expect(handler({ standard: "AAAA" }, ctx)).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects invalid severity", async () => {
    mockElements = [];
    const handler = accessibilityTools.find(
      (t) => t.tool.name === "accessibility_audit",
    )!.handler;
    const ctx = mockCtx();
    await expect(handler({ severity: "ultra" }, ctx)).rejects.toThrow(
      ValidationError,
    );
  });
});

// ── Relative scoring tests ──

function makeRuleResult(overrides: Partial<A11yRuleResult>): A11yRuleResult {
  return {
    ruleId: "test-rule",
    category: "labels",
    applicableCount: 0,
    passedCount: 0,
    issues: [],
    passRate: 1,
    ...overrides,
  };
}

describe("calculateRelativeScore", () => {
  it("returns 100 for empty ruleResults", () => {
    expect(calculateRelativeScore([])).toBe(100);
  });

  it("returns 100 when all rules have 0 applicableCount", () => {
    const results: A11yRuleResult[] = [
      makeRuleResult({ ruleId: "a", applicableCount: 0, passRate: 0 }),
      makeRuleResult({ ruleId: "b", applicableCount: 0, passRate: 0 }),
    ];
    expect(calculateRelativeScore(results)).toBe(100);
  });

  it("returns 100 when all rules have 100% passRate", () => {
    const results: A11yRuleResult[] = [
      makeRuleResult({ ruleId: "a", applicableCount: 5, passRate: 1.0 }),
      makeRuleResult({ ruleId: "b", applicableCount: 10, passRate: 1.0 }),
    ];
    expect(calculateRelativeScore(results)).toBe(100);
  });

  it("returns 50 for single rule with 50% passRate", () => {
    const results: A11yRuleResult[] = [
      makeRuleResult({ ruleId: "a", applicableCount: 10, passRate: 0.5 }),
    ];
    expect(calculateRelativeScore(results)).toBe(50);
  });

  it("calculates weighted average by applicableCount for mixed pass rates", () => {
    // Rule A: 10 applicable, passRate=0.8 => weighted = 8
    // Rule B: 2 applicable, passRate=1.0 => weighted = 2
    // Total applicable = 12, weighted sum = 10
    // Score = (10 / 12) * 100 = 83.33 => rounds to 83
    const results: A11yRuleResult[] = [
      makeRuleResult({ ruleId: "a", applicableCount: 10, passedCount: 8, passRate: 0.8 }),
      makeRuleResult({ ruleId: "b", applicableCount: 2, passedCount: 2, passRate: 1.0 }),
    ];
    expect(calculateRelativeScore(results)).toBe(83);
  });
});

describe("calculateCategoryScores", () => {
  it("groups rules by category", () => {
    const results: A11yRuleResult[] = [
      makeRuleResult({ ruleId: "missing-label", category: "labels", applicableCount: 5, passRate: 0.8 }),
      makeRuleResult({ ruleId: "interactive-labels", category: "labels", applicableCount: 3, passRate: 1.0 }),
      makeRuleResult({ ruleId: "touch-target", category: "touch-targets", applicableCount: 4, passRate: 0.5 }),
    ];
    const scores = calculateCategoryScores(results);

    expect(scores).toHaveLength(2);
    expect(scores[0].category).toBe("labels");
    expect(scores[0].rules).toHaveLength(2);
    expect(scores[1].category).toBe("touch-targets");
    expect(scores[1].rules).toHaveLength(1);
  });

  it("returns categories in CATEGORY_ORDER", () => {
    const results: A11yRuleResult[] = [
      makeRuleResult({ ruleId: "state-description", category: "states", applicableCount: 2, passRate: 1.0 }),
      makeRuleResult({ ruleId: "missing-label", category: "labels", applicableCount: 3, passRate: 1.0 }),
      makeRuleResult({ ruleId: "focus-order", category: "focus", applicableCount: 1, passRate: 1.0 }),
    ];
    const scores = calculateCategoryScores(results);
    const categories = scores.map(s => s.category);

    // CATEGORY_ORDER: labels, touch-targets, focus, states
    // Only labels, focus, states present
    expect(categories).toEqual(["labels", "focus", "states"]);
  });

  it("gives score 100 to category with 0 applicable elements", () => {
    const results: A11yRuleResult[] = [
      makeRuleResult({ ruleId: "touch-target", category: "touch-targets", applicableCount: 0, passRate: 0 }),
    ];
    const scores = calculateCategoryScores(results);

    expect(scores).toHaveLength(1);
    expect(scores[0].score).toBe(100);
  });

  it("calculates weighted average within category for mixed rules", () => {
    // Rule A (labels): 10 applicable, passRate=0.6 => weighted = 6
    // Rule B (labels): 5 applicable, passRate=1.0 => weighted = 5
    // Total applicable = 15, weighted sum = 11
    // Score = (11 / 15) * 100 = 73.33 => rounds to 73
    const results: A11yRuleResult[] = [
      makeRuleResult({ ruleId: "missing-label", category: "labels", applicableCount: 10, passRate: 0.6, passedCount: 6 }),
      makeRuleResult({ ruleId: "interactive-labels", category: "labels", applicableCount: 5, passRate: 1.0, passedCount: 5 }),
    ];
    const scores = calculateCategoryScores(results);

    expect(scores).toHaveLength(1);
    expect(scores[0].score).toBe(73);
  });
});

describe("generateActionItems", () => {
  it("returns empty array when no issues", () => {
    const results: A11yRuleResult[] = [
      makeRuleResult({ ruleId: "missing-label", category: "labels", issues: [] }),
    ];
    expect(generateActionItems(results)).toEqual([]);
  });

  it("returns items sorted by severity (critical first)", () => {
    const results: A11yRuleResult[] = [
      makeRuleResult({
        ruleId: "duplicate-descriptions",
        category: "states",
        issues: [{
          ruleId: "duplicate-descriptions", wcag: "1.3.1", severity: "moderate",
          message: "dup", element: { index: 0, className: "Button", resourceId: "", bounds: { x1: 0, y1: 0, x2: 100, y2: 100 }, centerX: 50, centerY: 50 },
        }],
      }),
      makeRuleResult({
        ruleId: "missing-label",
        category: "labels",
        issues: [{
          ruleId: "missing-label", wcag: "1.1.1", severity: "critical",
          message: "no label", element: { index: 1, className: "Button", resourceId: "", bounds: { x1: 0, y1: 0, x2: 100, y2: 100 }, centerX: 50, centerY: 50 },
        }],
      }),
    ];
    const items = generateActionItems(results);

    expect(items).toHaveLength(2);
    expect(items[0].severity).toBe("critical");
    expect(items[0].ruleId).toBe("missing-label");
    expect(items[1].severity).toBe("moderate");
    expect(items[1].ruleId).toBe("duplicate-descriptions");
  });

  it("uses ACTION_TEMPLATES for message content", () => {
    const results: A11yRuleResult[] = [
      makeRuleResult({
        ruleId: "missing-label",
        category: "labels",
        issues: [{
          ruleId: "missing-label", wcag: "1.1.1", severity: "critical",
          message: "no label", element: { index: 0, className: "Button", resourceId: "", bounds: { x1: 0, y1: 0, x2: 100, y2: 100 }, centerX: 50, centerY: 50 },
        }],
      }),
      makeRuleResult({
        ruleId: "touch-target",
        category: "touch-targets",
        issues: [
          {
            ruleId: "touch-target", wcag: "2.5.5", severity: "serious",
            message: "small", element: { index: 1, className: "Button", resourceId: "", bounds: { x1: 0, y1: 0, x2: 30, y2: 30 }, centerX: 15, centerY: 15 },
          },
          {
            ruleId: "touch-target", wcag: "2.5.5", severity: "serious",
            message: "small", element: { index: 2, className: "Button", resourceId: "", bounds: { x1: 0, y1: 0, x2: 20, y2: 20 }, centerX: 10, centerY: 10 },
          },
        ],
      }),
    ];
    const items = generateActionItems(results);

    expect(items.find(i => i.ruleId === "missing-label")!.message).toContain("Add labels");
    expect(items.find(i => i.ruleId === "touch-target")!.message).toContain("Fix touch targets");
  });

  it("uses correct plural vs singular forms", () => {
    const singleIssue: A11yRuleResult[] = [
      makeRuleResult({
        ruleId: "missing-label",
        category: "labels",
        issues: [{
          ruleId: "missing-label", wcag: "1.1.1", severity: "critical",
          message: "no label", element: { index: 0, className: "Button", resourceId: "", bounds: { x1: 0, y1: 0, x2: 100, y2: 100 }, centerX: 50, centerY: 50 },
        }],
      }),
    ];
    const singleItems = generateActionItems(singleIssue);
    expect(singleItems[0].message).toContain("1 clickable element ");
    expect(singleItems[0].message).not.toContain("elements");

    const multiIssue: A11yRuleResult[] = [
      makeRuleResult({
        ruleId: "missing-label",
        category: "labels",
        issues: [
          {
            ruleId: "missing-label", wcag: "1.1.1", severity: "critical",
            message: "no label", element: { index: 0, className: "Button", resourceId: "", bounds: { x1: 0, y1: 0, x2: 100, y2: 100 }, centerX: 50, centerY: 50 },
          },
          {
            ruleId: "missing-label", wcag: "1.1.1", severity: "critical",
            message: "no label", element: { index: 1, className: "Button", resourceId: "", bounds: { x1: 0, y1: 0, x2: 100, y2: 100 }, centerX: 50, centerY: 50 },
          },
        ],
      }),
    ];
    const multiItems = generateActionItems(multiIssue);
    expect(multiItems[0].message).toContain("2 clickable elements");
  });
});

// ── Formatter: category breakdown and action items ──

describe("formatCategoryBreakdown", () => {
  it("formats categories as aligned table with percentage and passed/total", () => {
    const categories: A11yCategoryScore[] = [
      {
        category: "labels",
        label: "Labels",
        score: 80,
        applicableCount: 10,
        issueCount: 2,
        rules: [],
      },
      {
        category: "touch-targets",
        label: "Touch Targets",
        score: 100,
        applicableCount: 5,
        issueCount: 0,
        rules: [],
      },
    ];
    const text = formatCategoryBreakdown(categories);

    expect(text).toContain("Labels");
    expect(text).toContain("80%");
    expect(text).toContain("8/10 passed");
    expect(text).toContain("Touch Targets");
    expect(text).toContain("100%");
    expect(text).toContain("5/5 passed");
  });

  it("shows percentage and passed/total counts", () => {
    const categories: A11yCategoryScore[] = [
      {
        category: "focus",
        label: "Focus",
        score: 50,
        applicableCount: 4,
        issueCount: 2,
        rules: [],
      },
    ];
    const text = formatCategoryBreakdown(categories);

    expect(text).toContain("50%");
    expect(text).toContain("2/4 passed");
  });
});

describe("formatActionItems", () => {
  it("returns empty string when no items", () => {
    expect(formatActionItems([])).toBe("");
  });

  it("formats items with severity and message", () => {
    const items = [
      { ruleId: "missing-label", category: "labels" as const, severity: "critical" as const, count: 2, message: "Add labels to 2 clickable elements" },
    ];
    const text = formatActionItems(items);
    expect(text).toContain("ACTION ITEMS:");
    expect(text).toContain("[critical]");
    expect(text).toContain("Add labels to 2 clickable elements");
  });
});

// ── duplicate-descriptions password skip ──

describe("duplicate-descriptions password skip", () => {
  it("excludes password elements from duplicate detection", () => {
    const el1 = makeElement({ index: 0, contentDesc: "Enter password", password: true });
    const el2 = makeElement({ index: 1, contentDesc: "Enter password", password: false });
    const { issues } = duplicateDescriptionsRule.run([el1, el2]);
    // el1 is password => skipped, only el2 remains => no duplicate
    expect(issues).toHaveLength(0);
  });

  it("reports duplicates for two non-password elements with same contentDesc", () => {
    const el1 = makeElement({ index: 0, contentDesc: "Star rating", password: false });
    const el2 = makeElement({ index: 1, contentDesc: "Star rating", password: false });
    const { issues } = duplicateDescriptionsRule.run([el1, el2]);
    expect(issues).toHaveLength(2);
    expect(issues[0].ruleId).toBe("duplicate-descriptions");
  });
});

// ── Severity filter bug fix ──

describe("severity filter bug fix", () => {
  it("severity filter does not affect score calculation", async () => {
    // Elements that will fail both missing-label and touch-target rules
    mockElements = [
      makeElement({
        index: 0,
        clickable: true,
        text: "",
        contentDesc: "",
        focusable: true,
        width: 30,
        height: 30,
        bounds: { x1: 0, y1: 0, x2: 30, y2: 30 },
      }),
      makeElement({
        index: 1,
        clickable: true,
        text: "OK",
        focusable: true,
        width: 48,
        height: 48,
        bounds: { x1: 0, y1: 0, x2: 48, y2: 48 },
      }),
    ];

    const handler = accessibilityTools.find(
      (t) => t.tool.name === "accessibility_audit",
    )!.handler;
    const ctx = mockCtx();

    // Run without severity filter
    const resultAll = (await handler({}, ctx)) as { text: string };
    // Run with severity filter = critical
    const resultCritical = (await handler({ severity: "critical" }, ctx)) as { text: string };

    // Extract score from output — format is "(score: NN/100)"
    const scoreRegex = /score:\s*(\d+)\/100/;
    const scoreAll = resultAll.text.match(scoreRegex)?.[1];
    const scoreCritical = resultCritical.text.match(scoreRegex)?.[1];

    expect(scoreAll).toBeDefined();
    expect(scoreCritical).toBeDefined();
    // Score must be the same regardless of severity filter
    expect(scoreAll).toBe(scoreCritical);
  });
});
