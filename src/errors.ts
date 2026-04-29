/**
 * Typed error classes for better error classification and handling.
 * Enables Claude to auto-suggest fixes and enables smart retry logic.
 */

export class MobileError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class DeviceNotFoundError extends MobileError {
  constructor(deviceId?: string) {
    super(
      deviceId
        ? `Device not found: ${deviceId}. Use device(action:'list') to see connected devices.`
        : "No device connected. Connect a device or start an emulator.",
      "DEVICE_NOT_FOUND"
    );
  }
}

export class AdbNotInstalledError extends MobileError {
  constructor() {
    super(
      "ADB is not installed or not in PATH.\n\nInstall Android SDK or run: brew install android-platform-tools",
      "ADB_NOT_INSTALLED"
    );
  }
}

export class SimctlNotInstalledError extends MobileError {
  constructor() {
    super(
      "xcrun simctl is not available.\n\nInstall Xcode from the App Store.",
      "SIMCTL_NOT_INSTALLED"
    );
  }
}

export class DeviceOfflineError extends MobileError {
  constructor(deviceId: string) {
    super(
      `Device ${deviceId} is offline. Try:\n  adb reconnect\n  adb kill-server && adb start-server`,
      "DEVICE_OFFLINE"
    );
  }
}

export class PermissionDeniedError extends MobileError {
  constructor(detail?: string) {
    super(
      `Permission denied${detail ? `: ${detail}` : ""}. Check USB debugging is enabled.`,
      "PERMISSION_DENIED"
    );
  }
}

export class CommandTimeoutError extends MobileError {
  constructor(_command: string, timeoutMs: number) {
    super(
      `Command timed out after ${timeoutMs}ms`,
      "COMMAND_TIMEOUT"
    );
  }
}

export class WdaNotInstalledError extends MobileError {
  constructor() {
    super(
      "WebDriverAgent not found.\n\nInstall: npm install -g appium && appium driver install xcuitest\nOr set WDA_PATH environment variable.",
      "WDA_NOT_INSTALLED"
    );
  }
}

export class ElementNotFoundError extends MobileError {
  constructor(criteria: string) {
    super(
      `Element not found: ${criteria}. Use ui(action:'tree') or ui(action:'analyze') to see available elements.`,
      "ELEMENT_NOT_FOUND"
    );
  }
}

export class WebViewNotFoundError extends MobileError {
  constructor() {
    super(
      "No WebView found in the current app. Make sure the app has an active WebView with debugging enabled.",
      "WEBVIEW_NOT_FOUND"
    );
  }
}

export class BrowserSecurityError extends MobileError {
  constructor(url: string, protocol: string) {
    super(
      `Blocked URL "${url}". Protocol "${protocol}" is not allowed. Use http:// or https://.`,
      "BROWSER_SECURITY"
    );
  }
}

export class BrowserSessionNotFoundError extends MobileError {
  constructor(session: string, active: string[]) {
    super(
      `Browser session "${session}" not found.${active.length > 0 ? ` Active sessions: ${active.join(", ")}.` : ""} Use browser(action:'open') to start a session.`,
      "BROWSER_SESSION_NOT_FOUND"
    );
  }
}

export class BrowserNoSessionError extends MobileError {
  constructor() {
    super(
      "No active browser session. Call browser(action:'open', url:...) to start.",
      "BROWSER_NO_SESSION"
    );
  }
}

export class BrowserRefNotFoundError extends MobileError {
  constructor(ref: string, lastKnown?: string) {
    super(
      `Ref "${ref}" is stale or not found${lastKnown ? ` (was: ${lastKnown})` : ""}. Call browser(action:'snapshot') to get fresh refs.`,
      "BROWSER_REF_NOT_FOUND"
    );
  }
}

export class ChromeNotInstalledError extends MobileError {
  constructor() {
    super(
      "Chrome/Chromium not found. Install Google Chrome: https://google.com/chrome or set CHROME_PATH environment variable.",
      "CHROME_NOT_INSTALLED"
    );
  }
}

export class ModuleNotLoadedError extends MobileError {
  constructor(moduleName: string) {
    super(
      `Module "${moduleName}" is not loaded. Use device(action:'enable_module', module:'${moduleName}') to enable it.`,
      "MODULE_NOT_LOADED"
    );
  }
}

export class UnknownActionError extends MobileError {
  constructor(tool: string, action: string, validActions: string[]) {
    super(
      `Unknown action "${action}" for ${tool}. Valid: ${validActions.join(", ")}`,
      "UNKNOWN_ACTION"
    );
  }
}

export class ValidationError extends MobileError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
  }
}

// Visual Regression errors

export class BaselineNotFoundError extends MobileError {
  constructor(name: string, platform: string) {
    super(
      `Baseline "${name}" not found for platform "${platform}". Use visual(action:'baseline_save') to create one.`,
      "BASELINE_NOT_FOUND"
    );
  }
}

export class BaselineExistsError extends MobileError {
  constructor(name: string, platform: string) {
    super(
      `Baseline "${name}" already exists for platform "${platform}". Use overwrite:true or visual(action:'baseline_update').`,
      "BASELINE_EXISTS"
    );
  }
}

export class VisualMismatchError extends MobileError {
  constructor(name: string, platform: string, diffPercent: number, threshold: number) {
    super(
      `Visual mismatch: "${name}" (${platform}) — ${diffPercent.toFixed(1)}% diff exceeds ${threshold}% threshold.`,
      "VISUAL_MISMATCH"
    );
  }
}

export class BaselineCorruptedError extends MobileError {
  constructor(name: string, reason: string) {
    super(
      `Baseline "${name}" corrupted: ${reason}. Use visual(action:'baseline_update') to recreate.`,
      "BASELINE_CORRUPTED"
    );
  }
}

// Test Scenario Recorder errors

export class RecorderAlreadyActiveError extends MobileError {
  constructor(currentName: string) {
    super(
      `Recording already in progress: "${currentName}". Use recorder(action:'stop') first.`,
      "RECORDER_ALREADY_ACTIVE"
    );
  }
}

export class RecorderNotActiveError extends MobileError {
  constructor() {
    super(
      "No recording in progress. Use recorder(action:'start') to begin.",
      "RECORDER_NOT_ACTIVE"
    );
  }
}

export class ScenarioNotFoundError extends MobileError {
  constructor(name: string, platform: string) {
    super(
      `Scenario "${name}" not found for platform "${platform}". Use recorder(action:'list') to see saved scenarios.`,
      "SCENARIO_NOT_FOUND"
    );
  }
}

export class ScenarioExistsError extends MobileError {
  constructor(name: string, platform: string) {
    super(
      `Scenario "${name}" already exists for platform "${platform}". Use overwrite:true or recorder(action:'delete').`,
      "SCENARIO_EXISTS"
    );
  }
}

export class ScenarioCorruptedError extends MobileError {
  constructor(name: string, reason: string) {
    super(
      `Scenario "${name}" corrupted: ${reason}. Delete and re-record.`,
      "SCENARIO_CORRUPTED"
    );
  }
}

// Multi-Device Sync errors

export class SyncGroupNotFoundError extends MobileError {
  constructor(name: string) {
    super(
      `Sync group "${name}" not found. Use sync(action:'list') to see active groups.`,
      "SYNC_GROUP_NOT_FOUND"
    );
  }
}

export class SyncGroupExistsError extends MobileError {
  constructor(name: string) {
    super(
      `Sync group "${name}" already exists. Use sync(action:'destroy') first or choose a different name.`,
      "SYNC_GROUP_EXISTS"
    );
  }
}

export class SyncBarrierTimeoutError extends MobileError {
  constructor(barrierName: string, timeoutMs: number) {
    super(
      `Barrier "${barrierName}" timed out after ${timeoutMs}ms. Not all roles reached the barrier in time.`,
      "SYNC_BARRIER_TIMEOUT"
    );
  }
}

export class SyncRoleNotFoundError extends MobileError {
  constructor(role: string, group: string) {
    super(
      `Role "${role}" not found in sync group "${group}". Use sync(action:'status') to see defined roles.`,
      "SYNC_ROLE_NOT_FOUND"
    );
  }
}

// Accessibility Guardian errors

export class A11yAuditError extends MobileError {
  constructor(message: string) {
    super(message, "A11Y_AUDIT_ERROR");
  }
}

export class A11yRuleNotFoundError extends MobileError {
  constructor(ruleId: string) {
    super(
      `Accessibility rule "${ruleId}" not found. Use accessibility(action:'rules') to see available rules.`,
      "A11Y_RULE_NOT_FOUND"
    );
  }
}

// AI Test Autopilot errors

export class ExplorationNotFoundError extends MobileError {
  constructor(id: string) {
    super(
      `Exploration "${id}" not found. Use autopilot(action:'explore') to create one.`,
      "EXPLORATION_NOT_FOUND"
    );
  }
}

export class ExplorationLimitError extends MobileError {
  constructor(detail: string) {
    super(
      `Exploration limit: ${detail}`,
      "EXPLORATION_LIMIT"
    );
  }
}

export class HealingFailedError extends MobileError {
  constructor(detail: string) {
    super(
      `Self-healing failed: ${detail}`,
      "HEALING_FAILED"
    );
  }
}

export class TestGenerationError extends MobileError {
  constructor(detail: string) {
    super(
      `Test generation failed: ${detail}`,
      "TEST_GENERATION_ERROR"
    );
  }
}

// Performance & Crash Monitor errors

export class PerfBaselineNotFoundError extends MobileError {
  constructor(name: string, platform: string) {
    super(
      `Performance baseline "${name}" not found for ${platform}. Use performance(action:'baseline') to create one.`,
      "PERF_BASELINE_NOT_FOUND"
    );
  }
}

export class PerfBaselineExistsError extends MobileError {
  constructor(name: string) {
    super(
      `Performance baseline "${name}" already exists. Use overwrite:true to replace.`,
      "PERF_BASELINE_EXISTS"
    );
  }
}

export class PerfCollectionError extends MobileError {
  constructor(platform: string, detail: string) {
    super(
      `Failed to collect performance metrics on ${platform}: ${detail}`,
      "PERF_COLLECTION_ERROR"
    );
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

/**
 * Classify ADB errors from stderr output
 */
export function classifyAdbError(stderr: string, command: string): MobileError {
  const msg = stderr.toLowerCase();

  if (msg.includes("not found") && (msg.includes("adb") || msg.includes("command"))) {
    return new AdbNotInstalledError();
  }
  if (msg.includes("device not found") || msg.includes("no devices") || msg.includes("device '' not found")) {
    return new DeviceNotFoundError();
  }
  if (msg.includes("device offline") || msg.includes("error: device offline")) {
    return new DeviceOfflineError(command.match(/-s (\S+)/)?.[1] ?? "unknown");
  }
  if (msg.includes("permission denied") || msg.includes("insufficient permissions")) {
    return new PermissionDeniedError(stderr.trim());
  }
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return new CommandTimeoutError(command, 0);
  }

  const cmdType = command.replace(/^adb\s+(-s\s+\S+\s+)?/, "").split(/\s+/)[0] ?? "unknown";
  return new MobileError(`ADB ${cmdType} failed: ${stderr.trim().slice(0, 200)}`, "ADB_ERROR");
}

/**
 * Classify simctl errors from stderr output
 */
export function classifySimctlError(stderr: string, command: string): MobileError {
  const msg = stderr.toLowerCase();

  if (msg.includes("xcrun: error: unable to find utility")) {
    return new SimctlNotInstalledError();
  }
  if (msg.includes("invalid device") || msg.includes("device not found")) {
    return new DeviceNotFoundError();
  }
  if (msg.includes("timed out")) {
    return new CommandTimeoutError(command, 0);
  }

  const cmdType = command.replace(/^xcrun\s+simctl\s+/, "").split(/\s+/)[0] ?? "unknown";
  return new MobileError(`simctl ${cmdType} failed: ${stderr.trim().slice(0, 200)}`, "SIMCTL_ERROR");
}
