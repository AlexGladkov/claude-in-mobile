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
        ? `Device not found: ${deviceId}. Run list_devices to see connected devices.`
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
  constructor(command: string, timeoutMs: number) {
    super(
      `Command timed out after ${timeoutMs}ms: ${command}`,
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
      `Element not found: ${criteria}. Use get_ui or analyze_screen to see available elements.`,
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
      `Browser session "${session}" not found.${active.length > 0 ? ` Active sessions: ${active.join(", ")}.` : ""} Use browser_open to start a session.`,
      "BROWSER_SESSION_NOT_FOUND"
    );
  }
}

export class BrowserNoSessionError extends MobileError {
  constructor() {
    super(
      "No active browser session. Call browser_open(url) to start.",
      "BROWSER_NO_SESSION"
    );
  }
}

export class BrowserRefNotFoundError extends MobileError {
  constructor(ref: string, lastKnown?: string) {
    super(
      `Ref "${ref}" is stale or not found${lastKnown ? ` (was: ${lastKnown})` : ""}. Call browser_snapshot to get fresh refs.`,
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

  return new MobileError(`ADB command failed: ${command}\n${stderr}`, "ADB_ERROR");
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

  return new MobileError(`simctl command failed: ${command}\n${stderr}`, "SIMCTL_ERROR");
}
