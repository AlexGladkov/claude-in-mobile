/**
 * Output truncation limits (chars/lines) for tool responses.
 * Centralised to prevent ad-hoc magic numbers across handlers.
 */

export const TRUNCATION = {
  /** Default cap for large textual dumps (UI tree XML, browser DOM, etc.). */
  DEFAULT_MAX_CHARS: 15_000,
  /** Cap for log-like outputs that are also line-bounded. */
  LOG_MAX_CHARS: 15_000,
  LOG_MAX_LINES: 300,
} as const;
