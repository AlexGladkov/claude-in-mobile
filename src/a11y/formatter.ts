import type { A11yReport, A11yIssue, A11ySeverity } from "./types.js";
import { SEVERITY_ORDER } from "./severity.js";

function shortClassName(className: string): string {
  return className.split(".").pop() ?? className;
}

function shortResourceId(resourceId: string): string {
  if (!resourceId) return "";
  return resourceId.split(":id/").pop() ?? resourceId;
}

function formatElementRef(issue: A11yIssue, redactPasswords: Set<number>): string {
  const el = issue.element;
  const shortClass = shortClassName(el.className);
  const parts: string[] = [`<${shortClass}>`];

  const shortId = shortResourceId(el.resourceId);
  if (shortId) {
    parts.push(`id="${shortId}"`);
  }

  parts.push(`@ (${el.centerX}, ${el.centerY})`);

  if (redactPasswords.has(el.index)) {
    parts.push("text=[REDACTED]");
  }

  return parts.join(" ");
}

function formatIssueFull(
  issue: A11yIssue,
  num: number,
  redactPasswords: Set<number>,
): string {
  const ref = formatElementRef(issue, redactPasswords);
  return [
    `  [${num}] ${issue.ruleId} (WCAG ${issue.wcag}) — ${ref}`,
    `      ${issue.message}`,
  ].join("\n");
}

function formatIssueCompact(
  issue: A11yIssue,
  num: number,
  redactPasswords: Set<number>,
): string {
  const ref = formatElementRef(issue, redactPasswords);
  return `  [${num}] ${issue.ruleId} (${issue.wcag}) — ${ref}`;
}

/**
 * Format an accessibility report as text for LLM consumption.
 * Follows the PASS/FAIL pattern from visual-tools.
 */
export function formatAuditReport(
  report: A11yReport,
  options?: { compact?: boolean; passwordIndices?: Set<number> },
): string {
  const compact = options?.compact === true;
  const passwordIndices = options?.passwordIndices ?? new Set<number>();

  const hasCritical = report.issueCount.critical > 0;
  const isPassing = report.score >= 100 && !hasCritical;
  const status = isPassing ? "PASS" : "FAIL";

  const header = `A11Y AUDIT: ${status} (score: ${report.score}/100)`;
  const meta = `Platform: ${report.platform} | Elements: ${report.totalElements} | Standard: ${report.standard}`;
  const counts =
    `Issues: ${report.issueCount.critical} critical, ${report.issueCount.serious} serious, ` +
    `${report.issueCount.moderate} moderate, ${report.issueCount.minor} minor (${report.issueCount.total} total)`;

  const lines: string[] = [header, meta, counts];

  if (report.issues.length > 0) {
    // Sort issues by severity
    const sorted = [...report.issues].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );

    // Group by severity
    const groups = new Map<A11ySeverity, A11yIssue[]>();
    for (const issue of sorted) {
      const existing = groups.get(issue.severity);
      if (existing) {
        existing.push(issue);
      } else {
        groups.set(issue.severity, [issue]);
      }
    }

    let issueNum = 1;
    const severityLabels: Array<[A11ySeverity, string]> = [
      ["critical", "CRITICAL"],
      ["serious", "SERIOUS"],
      ["moderate", "MODERATE"],
      ["minor", "MINOR"],
    ];

    for (const [sev, label] of severityLabels) {
      const groupIssues = groups.get(sev);
      if (!groupIssues || groupIssues.length === 0) continue;

      lines.push("");
      lines.push(`${label}:`);
      for (const issue of groupIssues) {
        if (compact) {
          lines.push(formatIssueCompact(issue, issueNum, passwordIndices));
        } else {
          lines.push(formatIssueFull(issue, issueNum, passwordIndices));
        }
        issueNum++;
      }
    }
  }

  if (report.passedRules.length > 0) {
    lines.push("");
    lines.push(`Passed rules: ${report.passedRules.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Format a summary-only report (score + counts, no individual issues).
 */
export function formatAuditSummary(report: A11yReport): string {
  const hasCritical = report.issueCount.critical > 0;
  const isPassing = report.score >= 100 && !hasCritical;
  const status = isPassing ? "PASS" : "FAIL";

  return [
    `A11Y: ${status} (score: ${report.score}/100)`,
    `Platform: ${report.platform} | Elements: ${report.totalElements} | Standard: ${report.standard}`,
    `Issues: ${report.issueCount.critical} critical, ${report.issueCount.serious} serious, ${report.issueCount.moderate} moderate, ${report.issueCount.minor} minor (${report.issueCount.total} total)`,
    `Passed: ${report.passedRules.length} rules`,
  ].join("\n");
}

/**
 * Format a list of all rules.
 */
export function formatRuleList(
  rules: Array<{ id: string; name: string; wcag: string; severity: A11ySeverity; description: string; platforms: string[] }>,
): string {
  const lines: string[] = [`Accessibility rules: ${rules.length} total`, ""];

  for (const rule of rules) {
    lines.push(`  ${rule.id} (WCAG ${rule.wcag}, ${rule.severity})`);
    lines.push(`    ${rule.description}`);
    lines.push(`    Platforms: ${rule.platforms.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Format details of a single rule.
 */
export function formatRuleDetail(rule: {
  id: string;
  name: string;
  wcag: string;
  severity: A11ySeverity;
  description: string;
  platforms: string[];
}): string {
  return [
    `Rule: ${rule.id}`,
    `Name: ${rule.name}`,
    `WCAG: ${rule.wcag}`,
    `Severity: ${rule.severity}`,
    `Description: ${rule.description}`,
    `Platforms: ${rule.platforms.join(", ")}`,
  ].join("\n");
}
