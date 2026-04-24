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
import { calculateScore } from "../a11y/score.js";
import { formatAuditReport, formatAuditSummary } from "../a11y/formatter.js";
import type { A11yReport } from "../a11y/types.js";
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
    const issues = missingLabelRule.run([el]);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe("missing-label");
    expect(issues[0].severity).toBe("critical");
  });

  it("passes when element has text", () => {
    const el = makeElement({ clickable: true, text: "Login" });
    const issues = missingLabelRule.run([el]);
    expect(issues).toHaveLength(0);
  });

  it("passes when element has contentDesc", () => {
    const el = makeElement({ clickable: true, contentDesc: "Menu" });
    const issues = missingLabelRule.run([el]);
    expect(issues).toHaveLength(0);
  });

  it("skips non-clickable elements", () => {
    const el = makeElement({ clickable: false, text: "", contentDesc: "" });
    const issues = missingLabelRule.run([el]);
    expect(issues).toHaveLength(0);
  });

  it("skips container classes", () => {
    const el = makeElement({
      clickable: true,
      text: "",
      contentDesc: "",
      className: "android.widget.LinearLayout",
    });
    const issues = missingLabelRule.run([el]);
    expect(issues).toHaveLength(0);
  });

  it("handles password elements — missing contentDesc is flagged", () => {
    const el = makeElement({
      clickable: true,
      password: true,
      text: "",
      contentDesc: "",
    });
    const issues = missingLabelRule.run([el]);
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
    const issues = missingLabelRule.run([el]);
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
    const issues = touchTargetRule.run([el]);
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
    const issues = touchTargetRule.run([el]);
    expect(issues).toHaveLength(0);
  });

  it("skips invisible elements (0 size)", () => {
    const el = makeElement({
      clickable: true,
      width: 0,
      height: 0,
      bounds: { x1: 0, y1: 0, x2: 0, y2: 0 },
    });
    const issues = touchTargetRule.run([el]);
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
    const issues = interactiveLabelsRule.run([el]);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe("interactive-labels");
  });

  it("passes ImageView with contentDesc", () => {
    const el = makeElement({
      clickable: true,
      className: "android.widget.ImageView",
      contentDesc: "Profile picture",
    });
    const issues = interactiveLabelsRule.run([el]);
    expect(issues).toHaveLength(0);
  });

  it("skips non-image clickable elements", () => {
    const el = makeElement({
      clickable: true,
      className: "android.widget.Button",
      contentDesc: "",
    });
    const issues = interactiveLabelsRule.run([el]);
    expect(issues).toHaveLength(0);
  });
});

describe("focus-order rule", () => {
  it("detects clickable but not focusable", () => {
    const el = makeElement({ clickable: true, focusable: false });
    const issues = focusOrderRule.run([el]);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe("focus-order");
  });

  it("passes when clickable and focusable", () => {
    const el = makeElement({ clickable: true, focusable: true });
    const issues = focusOrderRule.run([el]);
    expect(issues).toHaveLength(0);
  });
});

describe("duplicate-descriptions rule", () => {
  it("detects duplicate contentDesc", () => {
    const el1 = makeElement({ index: 0, contentDesc: "Star" });
    const el2 = makeElement({ index: 1, contentDesc: "Star" });
    const issues = duplicateDescriptionsRule.run([el1, el2]);
    expect(issues).toHaveLength(2);
    expect(issues[0].ruleId).toBe("duplicate-descriptions");
  });

  it("skips short contentDesc (<=1 char)", () => {
    const el1 = makeElement({ index: 0, contentDesc: "X" });
    const el2 = makeElement({ index: 1, contentDesc: "X" });
    const issues = duplicateDescriptionsRule.run([el1, el2]);
    expect(issues).toHaveLength(0);
  });

  it("passes when all descriptions are unique", () => {
    const el1 = makeElement({ index: 0, contentDesc: "Edit" });
    const el2 = makeElement({ index: 1, contentDesc: "Delete" });
    const issues = duplicateDescriptionsRule.run([el1, el2]);
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
    const issues = stateDescriptionRule.run([el]);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe("state-description");
  });

  it("passes when checkable has text", () => {
    const el = makeElement({
      checkable: true,
      text: "Enable notifications",
    });
    const issues = stateDescriptionRule.run([el]);
    expect(issues).toHaveLength(0);
  });
});

// ── Score tests ──

describe("calculateScore", () => {
  it("returns 100 for zero issues", () => {
    expect(calculateScore([])).toBe(100);
  });

  it("returns 85 for one critical issue", () => {
    const issues = missingLabelRule.run([
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
    expect(calculateScore([...critical, ...serious])).toBe(77);
  });

  it("clamps to 0 for many issues", () => {
    const elements = Array.from({ length: 20 }, (_, i) =>
      makeElement({ index: i, clickable: true, text: "", contentDesc: "" }),
    );
    const issues = missingLabelRule.run(elements);
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
