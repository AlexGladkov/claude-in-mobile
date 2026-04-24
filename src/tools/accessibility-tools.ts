import type { ToolDefinition } from "./registry.js";
import type { Platform } from "../device-manager.js";
import { getUiElements } from "./helpers/get-elements.js";
import { ALL_RULES, getRuleById } from "../a11y/rules/index.js";
import { calculateScore } from "../a11y/score.js";
import {
  formatAuditReport,
  formatAuditSummary,
  formatRuleList,
  formatRuleDetail,
} from "../a11y/formatter.js";
import type { A11yIssue, A11yReport, A11ySeverity } from "../a11y/types.js";
import type { UiElement } from "../adb/ui-parser.js";
import { truncateOutput } from "../utils/truncate.js";
import { ValidationError, A11yRuleNotFoundError } from "../errors.js";

const VALID_STANDARDS = new Set(["A", "AA", "AAA"]);
const VALID_SEVERITIES = new Set(["critical", "serious", "moderate", "minor"]);

function validateStandard(standard: unknown): string {
  if (standard === undefined || standard === null) return "AA";
  const s = String(standard).toUpperCase();
  if (!VALID_STANDARDS.has(s)) {
    throw new ValidationError(
      `Invalid standard: "${standard}". Valid: A, AA, AAA`,
    );
  }
  return s;
}

function validateSeverityFilter(severity: unknown): A11ySeverity | undefined {
  if (severity === undefined || severity === null) return undefined;
  const s = String(severity).toLowerCase();
  if (!VALID_SEVERITIES.has(s)) {
    throw new ValidationError(
      `Invalid severity: "${severity}". Valid: critical, serious, moderate, minor`,
    );
  }
  return s as A11ySeverity;
}

function runAudit(
  elements: UiElement[],
  platform: string,
  standard: string,
  severityFilter?: A11ySeverity,
): { report: A11yReport; passwordIndices: Set<number> } {
  // Collect password element indices for redaction
  const passwordIndices = new Set<number>();
  for (const el of elements) {
    if (el.password) {
      passwordIndices.add(el.index);
    }
  }

  let allIssues: A11yIssue[] = [];
  const passedRules: string[] = [];

  for (const rule of ALL_RULES) {
    if (!rule.platforms.includes(platform as "android" | "ios" | "desktop")) {
      passedRules.push(rule.id);
      continue;
    }

    const issues = rule.run(elements);
    if (issues.length === 0) {
      passedRules.push(rule.id);
    } else {
      allIssues.push(...issues);
    }
  }

  // Apply severity filter if provided
  if (severityFilter) {
    allIssues = allIssues.filter((i) => i.severity === severityFilter);
  }

  const score = calculateScore(allIssues);

  const issueCount = {
    critical: allIssues.filter((i) => i.severity === "critical").length,
    serious: allIssues.filter((i) => i.severity === "serious").length,
    moderate: allIssues.filter((i) => i.severity === "moderate").length,
    minor: allIssues.filter((i) => i.severity === "minor").length,
    total: allIssues.length,
  };

  const report: A11yReport = {
    platform,
    timestamp: new Date().toISOString(),
    score,
    totalElements: elements.length,
    issueCount,
    issues: allIssues,
    passedRules,
    standard,
  };

  return { report, passwordIndices };
}

export const accessibilityTools: ToolDefinition[] = [
  // 1. audit
  {
    tool: {
      name: "accessibility_audit",
      description:
        "Run full accessibility audit on current screen. Returns score, issues grouped by severity, and passed rules.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop"],
            description: "Target platform",
          },
          standard: {
            type: "string",
            enum: ["A", "AA", "AAA"],
            description: "WCAG conformance level (default: AA)",
          },
          severity: {
            type: "string",
            enum: ["critical", "serious", "moderate", "minor"],
            description: "Filter issues by severity",
          },
          compact: {
            type: "boolean",
            description:
              "Compact output: one line per issue, no descriptions (default: false)",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform =
        (args.platform as Platform | undefined) ??
        ctx.deviceManager.getCurrentPlatform() ??
        "android";
      const standard = validateStandard(args.standard);
      const severityFilter = validateSeverityFilter(args.severity);
      const compact = args.compact === true;

      const { elements } = await getUiElements(ctx, platform);
      const { report, passwordIndices } = runAudit(
        elements,
        platform,
        standard,
        severityFilter,
      );

      const text = formatAuditReport(report, { compact, passwordIndices });
      const hasFail = report.issueCount.critical > 0 || report.score < 100;

      return {
        text: truncateOutput(text),
        ...(hasFail ? { isError: true } : {}),
      };
    },
  },

  // 2. check
  {
    tool: {
      name: "accessibility_check",
      description:
        "Check accessibility of a specific element found by text, resourceId, or index.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop"],
            description: "Target platform",
          },
          text: {
            type: "string",
            description: "Find element by text content (partial match)",
          },
          resourceId: {
            type: "string",
            description: "Find element by resource ID (partial match)",
          },
          index: {
            type: "number",
            description: "Find element by index",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform =
        (args.platform as Platform | undefined) ??
        ctx.deviceManager.getCurrentPlatform() ??
        "android";

      const text = args.text as string | undefined;
      const resourceId = args.resourceId as string | undefined;
      const elementIndex = args.index as number | undefined;

      if (text === undefined && resourceId === undefined && elementIndex === undefined) {
        throw new ValidationError(
          "Provide at least one of: text, resourceId, index to identify the element.",
        );
      }

      const { elements } = await getUiElements(ctx, platform);

      // Find matching element
      let target: UiElement | undefined;

      if (elementIndex !== undefined) {
        target = elements.find((el) => el.index === elementIndex);
      } else if (text !== undefined) {
        const lowerText = text.toLowerCase();
        target = elements.find(
          (el) =>
            el.text.toLowerCase().includes(lowerText) ||
            el.contentDesc.toLowerCase().includes(lowerText),
        );
      } else if (resourceId !== undefined) {
        target = elements.find((el) => el.resourceId.includes(resourceId));
      }

      if (!target) {
        const criteria = text
          ? `text="${text}"`
          : resourceId
            ? `resourceId="${resourceId}"`
            : `index=${elementIndex}`;
        throw new ValidationError(
          `Element not found: ${criteria}. Use ui(action:'tree') to see available elements.`,
        );
      }

      // Run all rules on just this element
      const { report, passwordIndices } = runAudit(
        [target],
        platform,
        "AA",
      );

      const output = formatAuditReport(report, { compact: false, passwordIndices });
      const hasFail = report.issueCount.total > 0;

      return {
        text: truncateOutput(output),
        ...(hasFail ? { isError: true } : {}),
      };
    },
  },

  // 3. summary
  {
    tool: {
      name: "accessibility_summary",
      description:
        "Quick accessibility summary: score + issue counts only (short output).",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop"],
            description: "Target platform",
          },
          standard: {
            type: "string",
            enum: ["A", "AA", "AAA"],
            description: "WCAG conformance level (default: AA)",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform =
        (args.platform as Platform | undefined) ??
        ctx.deviceManager.getCurrentPlatform() ??
        "android";
      const standard = validateStandard(args.standard);

      const { elements } = await getUiElements(ctx, platform);
      const { report } = runAudit(elements, platform, standard);

      const text = formatAuditSummary(report);
      const hasFail = report.issueCount.critical > 0 || report.score < 100;

      return {
        text,
        ...(hasFail ? { isError: true } : {}),
      };
    },
  },

  // 4. rules
  {
    tool: {
      name: "accessibility_rules",
      description:
        "List all accessibility rules or show details of a specific rule.",
      inputSchema: {
        type: "object",
        properties: {
          ruleId: {
            type: "string",
            description: "Specific rule ID to show details for",
          },
        },
      },
    },
    handler: async (args) => {
      const ruleId = args.ruleId as string | undefined;

      if (ruleId) {
        const rule = getRuleById(ruleId);
        if (!rule) {
          throw new A11yRuleNotFoundError(ruleId);
        }
        return { text: formatRuleDetail(rule) };
      }

      return { text: formatRuleList(ALL_RULES) };
    },
  },
];
