/**
 * Centralized output truncation to prevent LLM context overflow.
 * Tools like system_shell, system_logs, browser_evaluate can return
 * unbounded text — this utility caps output at safe limits.
 */

export interface TruncateOptions {
  /** Maximum characters in output (default: 10_000) */
  maxChars?: number;
  /** Maximum lines in output (default: 200) */
  maxLines?: number;
}

const DEFAULT_MAX_CHARS = 10_000;
const DEFAULT_MAX_LINES = 200;

/**
 * Truncate text output to safe limits for LLM consumption.
 * Applies line limit first, then character limit.
 * Appends a marker showing how much was truncated.
 */
export function truncateOutput(text: string, opts?: TruncateOptions): string {
  if (!text) return text;

  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;

  let result = text;
  let truncated = false;

  // Apply line limit first
  const lines = result.split("\n");
  if (lines.length > maxLines) {
    result = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }

  // Apply character limit
  if (result.length > maxChars) {
    result = result.slice(0, maxChars);
    truncated = true;
  }

  if (truncated) {
    const remaining = text.length - result.length;
    result += `\n\n[truncated, ${remaining} chars remaining]`;
  }

  return result;
}
