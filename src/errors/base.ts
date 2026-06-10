/**
 * Base error class + recovery / retry utilities shared by every category.
 */

export class MobileError extends Error {
  retryInfo?: string;
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Recovery hints: suggested tool calls to resolve each error type */
export const RECOVERY_HINTS: Record<string, { tool: string; args: Record<string, string> }[]> = {
  ELEMENT_NOT_FOUND: [{ tool: "ui", args: { action: "tree" } }],
  BROWSER_REF_NOT_FOUND: [{ tool: "browser", args: { action: "snapshot" } }],
  DEVICE_NOT_FOUND: [{ tool: "device", args: { action: "list" } }],
  DEVICE_OFFLINE: [{ tool: "device", args: { action: "list" } }],
  MODULE_NOT_LOADED: [], // dynamic — handled by getRecoveryHints
  BROWSER_NO_SESSION: [{ tool: "browser", args: { action: "open" } }],
  BROWSER_SESSION_NOT_FOUND: [{ tool: "browser", args: { action: "open" } }],
  SCENARIO_NOT_FOUND: [{ tool: "recorder", args: { action: "list" } }],
  BASELINE_NOT_FOUND: [{ tool: "visual", args: { action: "baseline_save" } }],
};

/** Get recovery hints for an error, with dynamic handling for MODULE_NOT_LOADED */
export function getRecoveryHints(error: unknown): { tool: string; args: Record<string, string> }[] {
  if (!(error instanceof MobileError)) return [];

  if (error.code === "MODULE_NOT_LOADED") {
    // Extract module name from message: 'Module "browser" is not loaded...'
    const match = error.message.match(/Module "(\w+)"/);
    if (match) {
      return [{ tool: "device", args: { action: "enable_module", module: match[1] } }];
    }
  }

  return RECOVERY_HINTS[error.code] ?? [];
}

const RETRYABLE_CODES = new Set([
  "DEVICE_OFFLINE", "COMMAND_TIMEOUT", "ADB_ERROR",
  "SYNC_BARRIER_TIMEOUT",
]);

export function isRetryable(error: unknown): boolean {
  return error instanceof MobileError && RETRYABLE_CODES.has(error.code);
}
