import type { A11yIssue } from "./types.js";
import { SEVERITY_WEIGHTS } from "./severity.js";

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
