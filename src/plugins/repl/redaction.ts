/**
 * Secret redaction for REPL output.
 *
 * The terminal stream from `repl_snapshot` is the most likely source of leaked
 * credentials: developers paste tokens, exports show env, password prompts
 * echo on some configurations. We replace common credential shapes with a
 * stable marker BEFORE the snapshot leaves the plugin process.
 *
 * False positives are acceptable; false negatives are not.
 */

export interface RedactionPattern {
  name: string;
  re: RegExp;
}

export const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "aws-secret", re: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g },
  { name: "github-pat", re: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  { name: "openai-key", re: /sk-[A-Za-z0-9]{20,}/g },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._\-]+/gi },
  { name: "jwt", re: /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g },
  { name: "google-api-key", re: /AIza[0-9A-Za-z\-_]{35}/g },
  { name: "slack-token", re: /xox[abprs]-[A-Za-z0-9\-]+/g },
];

const REDACTED_MARKER = "[REDACTED]";

export function redactScreen(text: string): string {
  let out = text;
  for (const { re } of REDACTION_PATTERNS) {
    out = out.replace(re, REDACTED_MARKER);
  }
  return out;
}
