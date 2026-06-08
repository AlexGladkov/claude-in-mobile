import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import type { Platform } from "../device-manager.js";
import { getUiElements } from "./helpers/get-elements.js";
import { ALL_RULES, getRuleById } from "../a11y/rules/index.js";
import { calculateRelativeScore, calculateCategoryScores, generateActionItems } from "../a11y/score.js";
import {
  formatAuditReport,
  formatAuditSummary,
  formatRuleList,
  formatRuleDetail,
  formatDetailedReport,
} from "../a11y/formatter.js";
import type { A11yIssue, A11ySeverity, A11yRuleResult, A11yDetailedReport, A11yCategory } from "../a11y/types.js";
import { getCategoryForRule } from "../a11y/categories.js";
import type { UiElement } from "../adb/ui-parser.js";
import { truncateOutput } from "../utils/truncate.js";
import { ValidationError, A11yRuleNotFoundError } from "../errors.js";
import { textResult, errorResult } from "../utils/tool-result.js";

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
): { report: A11yDetailedReport; passwordIndices: Set<number> } {
  const passwordIndices = new Set<number>();
  for (const el of elements) {
    if (el.password) passwordIndices.add(el.index);
  }

  const ruleResults: A11yRuleResult[] = [];
  const passedRules: string[] = [];
  const allIssues: A11yIssue[] = [];

  for (const rule of ALL_RULES) {
    if (!rule.platforms.includes(platform as "android" | "ios" | "desktop")) {
      passedRules.push(rule.id);
      continue;
    }

    const result = rule.run(elements);
    const category = getCategoryForRule(rule.id);
    const passedCount = result.applicableCount - result.issues.length;
    const passRate = result.applicableCount === 0 ? 1 : passedCount / result.applicableCount;

    ruleResults.push({
      ruleId: rule.id,
      category,
      applicableCount: result.applicableCount,
      passedCount,
      issues: result.issues,
      passRate,
    });

    if (result.issues.length === 0) {
      passedRules.push(rule.id);
    } else {
      allIssues.push(...result.issues);
    }
  }

  const score = calculateRelativeScore(ruleResults);
  const categories = calculateCategoryScores(ruleResults);
  const actionItems = generateActionItems(ruleResults);

  let displayIssues = allIssues;
  if (severityFilter) {
    displayIssues = allIssues.filter((i) => i.severity === severityFilter);
  }

  const issueCount = {
    critical: allIssues.filter((i) => i.severity === "critical").length,
    serious: allIssues.filter((i) => i.severity === "serious").length,
    moderate: allIssues.filter((i) => i.severity === "moderate").length,
    minor: allIssues.filter((i) => i.severity === "minor").length,
    total: allIssues.length,
  };

  const report: A11yDetailedReport = {
    platform,
    timestamp: new Date().toISOString(),
    score,
    totalElements: elements.length,
    issueCount,
    issues: displayIssues,
    passedRules,
    standard,
    categories,
    ruleResults,
    actionItems,
  };

  return { report, passwordIndices };
}

const MAX_AUDIT_ELEMENTS = 2000;

const deviceIdField = z
  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();

const a11yPlatformEnum = z
  .enum(["android", "ios", "desktop"])
  .optional()
  .describe("Target platform");

export const accessibilityTools: ToolDefinition[] = [
  defineTool({
    name: "accessibility_audit",
    description:
      "Run full accessibility audit on current screen. Returns score, issues grouped by severity, and passed rules.",
    schema: z.object({
      platform: a11yPlatformEnum,
      standard: z
        .string()
        .optional()
        .describe("WCAG conformance level (A, AA, AAA — default: AA)"),
      severity: z
        .string()
        .optional()
        .describe("Filter issues by severity (critical, serious, moderate, minor)"),
      compact: z
        .boolean()
        .optional()
        .describe("Compact output: one line per issue, no descriptions (default: false)"),
      detailed: z
        .boolean()
        .optional()
        .describe("Include category breakdown and action items (default: false)"),
      category: z
        .enum(["labels", "touch-targets", "focus", "states"])
        .optional()
        .describe("Filter to specific category"),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const platform: Platform =
        (args.platform as Platform | undefined) ??
        ctx.deviceManager.getCurrentPlatform() ??
        "android";
      const standard = validateStandard(args.standard);
      const severityFilter = validateSeverityFilter(args.severity);
      const compact = args.compact === true;
      const detailed = args.detailed === true;
      const categoryFilter = args.category as A11yCategory | undefined;

      const { elements } = await getUiElements(ctx, platform);

      let truncatedNote = "";
      let auditElements = elements;
      if (elements.length > MAX_AUDIT_ELEMENTS) {
        auditElements = elements.slice(0, MAX_AUDIT_ELEMENTS);
        truncatedNote = `\n\nNote: Screen has ${elements.length} elements, audit limited to first ${MAX_AUDIT_ELEMENTS}.`;
      }

      const { report, passwordIndices } = runAudit(
        auditElements,
        platform,
        standard,
        severityFilter,
      );

      let filteredReport = report;
      if (categoryFilter) {
        const filteredIssues = report.issues.filter((issue) => {
          const cat = getCategoryForRule(issue.ruleId);
          return cat === categoryFilter;
        });
        filteredReport = { ...report, issues: filteredIssues };
      }

      const text = detailed
        ? formatDetailedReport(filteredReport, { compact, passwordIndices })
        : formatAuditReport(filteredReport, { compact, passwordIndices });

      const hasFail = report.issueCount.critical > 0 || report.score < 100;
      const finalText = truncateOutput(text + truncatedNote);

      return hasFail ? errorResult(finalText) : textResult(finalText);
    },
  }),

  defineTool({
    name: "accessibility_check",
    description:
      "Check accessibility of a specific element found by text, resourceId, or index.",
    schema: z.object({
      platform: a11yPlatformEnum,
      text: z.string().optional().describe("Find element by text content (partial match)"),
      resourceId: z.string().optional().describe("Find element by resource ID (partial match)"),
      index: z.number().optional().describe("Find element by index"),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const platform: Platform =
        (args.platform as Platform | undefined) ??
        ctx.deviceManager.getCurrentPlatform() ??
        "android";

      const text = args.text;
      const resourceId = args.resourceId;
      const elementIndex = args.index;

      if (text === undefined && resourceId === undefined && elementIndex === undefined) {
        throw new ValidationError(
          "Provide at least one of: text, resourceId, index to identify the element.",
        );
      }

      const { elements } = await getUiElements(ctx, platform);

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

      const { report, passwordIndices } = runAudit([target], platform, "AA");

      const output = formatAuditReport(report, { compact: false, passwordIndices });
      const hasFail = report.issueCount.total > 0;
      const finalText = truncateOutput(output);

      return hasFail ? errorResult(finalText) : textResult(finalText);
    },
  }),

  defineTool({
    name: "accessibility_summary",
    description:
      "Quick accessibility summary: score + issue counts only (short output).",
    schema: z.object({
      platform: a11yPlatformEnum,
      standard: z.string().optional().describe("WCAG conformance level (A, AA, AAA — default: AA)"),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const platform: Platform =
        (args.platform as Platform | undefined) ??
        ctx.deviceManager.getCurrentPlatform() ??
        "android";
      const standard = validateStandard(args.standard);

      const { elements } = await getUiElements(ctx, platform);
      const { report } = runAudit(elements, platform, standard);

      const text = formatAuditSummary(report);
      const hasFail = report.issueCount.critical > 0 || report.score < 100;

      return hasFail ? errorResult(text) : textResult(text);
    },
  }),

  defineTool({
    name: "accessibility_rules",
    description:
      "List all accessibility rules or show details of a specific rule.",
    schema: z.object({
      ruleId: z.string().optional().describe("Specific rule ID to show details for"),
    }),
    handler: async (args) => {
      const ruleId = args.ruleId;

      if (ruleId) {
        const rule = getRuleById(ruleId);
        if (!rule) {
          throw new A11yRuleNotFoundError(ruleId);
        }
        return textResult(formatRuleDetail(rule));
      }

      return textResult(formatRuleList(ALL_RULES));
    },
  }),
];
