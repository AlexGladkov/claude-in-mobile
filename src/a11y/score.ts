import type { A11yIssue, A11yRuleResult, A11yCategoryScore, A11yActionItem, A11yCategory } from "./types.js";
import { SEVERITY_WEIGHTS, SEVERITY_ORDER } from "./severity.js";
import { CATEGORY_LABELS, CATEGORY_ORDER } from "./categories.js";

/**
 * Calculate accessibility score from issues.
 * Score = 100 - sum(severity weights), clamped to [0, 100].
 */
export function calculateScore(issues: A11yIssue[]): number {
  const penalty = issues.reduce(
    (sum, issue) => sum + (SEVERITY_WEIGHTS[issue.severity] ?? 0),
    0,
  );
  return Math.max(0, Math.min(100, 100 - penalty));
}

/**
 * Calculate relative accessibility score from rule results.
 * Score = weighted average of pass rates, weighted by applicableCount.
 * Rules with 0 applicable elements are treated as 100% pass.
 */
export function calculateRelativeScore(ruleResults: A11yRuleResult[]): number {
  let totalApplicable = 0;
  let weightedPassSum = 0;

  for (const r of ruleResults) {
    if (r.applicableCount === 0) continue;
    totalApplicable += r.applicableCount;
    weightedPassSum += r.passRate * r.applicableCount;
  }

  if (totalApplicable === 0) return 100;
  return Math.round((weightedPassSum / totalApplicable) * 100);
}

/**
 * Calculate per-category scores from rule results.
 * Categories follow CATEGORY_ORDER for consistent display.
 */
export function calculateCategoryScores(ruleResults: A11yRuleResult[]): A11yCategoryScore[] {
  const categoryMap = new Map<A11yCategory, A11yRuleResult[]>();

  for (const r of ruleResults) {
    const existing = categoryMap.get(r.category);
    if (existing) existing.push(r);
    else categoryMap.set(r.category, [r]);
  }

  return CATEGORY_ORDER
    .filter(cat => categoryMap.has(cat))
    .map(cat => {
      const rules = categoryMap.get(cat)!;
      const totalApplicable = rules.reduce((s, r) => s + r.applicableCount, 0);
      const totalIssues = rules.reduce((s, r) => s + r.issues.length, 0);
      const score = totalApplicable === 0
        ? 100
        : Math.round(
            rules.reduce((s, r) => s + r.passRate * r.applicableCount, 0) / totalApplicable * 100
          );

      return {
        category: cat,
        label: CATEGORY_LABELS[cat],
        score,
        applicableCount: totalApplicable,
        issueCount: totalIssues,
        rules,
      };
    });
}

/**
 * Generate actionable fix items from rule results.
 * Sorted by severity (critical first).
 */
export function generateActionItems(ruleResults: A11yRuleResult[]): A11yActionItem[] {
  return ruleResults
    .filter(r => r.issues.length > 0)
    .map(r => ({
      ruleId: r.ruleId,
      category: r.category,
      severity: r.issues[0].severity,
      count: r.issues.length,
      message: buildActionMessage(r.ruleId, r.issues.length),
    }))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

const ACTION_TEMPLATES: Record<string, (count: number) => string> = {
  "missing-label": (n) => `Add labels to ${n} clickable element${n > 1 ? "s" : ""} without text or content description`,
  "interactive-labels": (n) => `Add content descriptions to ${n} clickable image${n > 1 ? "s" : ""}`,
  "touch-target": (n) => `Fix touch targets on ${n} element${n > 1 ? "s" : ""} (minimum 48x48dp)`,
  "focus-order": (n) => `Make ${n} clickable element${n > 1 ? "s" : ""} focusable for keyboard navigation`,
  "duplicate-descriptions": (n) => `Fix ${n} element${n > 1 ? "s" : ""} with duplicate content descriptions`,
  "state-description": (n) => `Add labels to ${n} checkable element${n > 1 ? "s" : ""} (checkbox/switch/toggle)`,
};

function buildActionMessage(ruleId: string, count: number): string {
  const template = ACTION_TEMPLATES[ruleId];
  return template ? template(count) : `Fix ${count} ${ruleId} issue${count > 1 ? "s" : ""}`;
}
