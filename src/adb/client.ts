import { execFileSync } from "child_process";
import { resolveAdbPath } from "./resolver.js";
import { validatePackageName, validatePermission, validateDeviceId } from "../utils/sanitize.js";
import {
  EXEC_TIMEOUT_MS,
  execAdb,
  execAdbAsync,
  execAdbRaw,
  execAdbRawAsync,
} from "./exec.js";
import { escapeAndroidInputText, splitArgs } from "./text-escape.js";
import { UiTreeCache } from "../ui-tree/ui-tree-cache.js";
import { ANDROID_KEYCODES, ANDROID_KEYCODES_FAST, resolveKeyCode } from "./keycodes.js";
import {
  parseDevicesOutput,
  parseScreenSize,
  parseCurrentActivityFromActivities,
  parseCurrentFocusFromWindows,
  parseFocusFromDumpsysWindow,
  parseClipboardBroadcast,
  parseLaunchActivity,
  stripDumpPrefix,
  splitActionAndUiXml,
} from "./parsers.js";
import { buildLogcatArgs, filterLogsByPackage, type LogcatOptions } from "./logcat.js";

// Re-export helpers so existing imports of `src/adb/client.js` keep working.
export { escapeAndroidInputText, splitArgs } from "./text-escape.js";
export { UiTreeCache } from "../ui-tree/ui-tree-cache.js";
export { ANDROID_KEYCODES, ANDROID_KEYCODES_FAST, resolveKeyCode } from "./keycodes.js";
export {
  EXEC_TIMEOUT_MS,
  EXEC_RAW_TIMEOUT_MS,
  execAdb,
  execAdbAsync,
  execAdbRaw,
  execAdbRawAsync,
} from "./exec.js";

export interface Device {
  id: string;
  state: string;
  model?: string;
}

export class AdbClient {
  private deviceId?: string;

  // Turbo: UI tree TTL cache (active only when turbo=true is passed)
  private readonly uiTreeCache = new UiTreeCache(500);

  constructor(deviceId?: string) {
    if (deviceId) {
      validateDeviceId(deviceId);
    }
    this.deviceId = deviceId;
  }

  private get deviceFlag(): string {
    return this.deviceId ? `-s ${this.deviceId}` : "";
  }

  /**
   * SECURITY: All adb invocations route through this argv-form path (execFileSync — no /bin/sh -c).
   * Shell metacharacters in `args` are passed as literal argv slots, not parsed by the host shell.
   * This structurally prevents host-side OS Command Injection (CWE-78) — see issue #40.
   */
  private execArgs(args: string[], deviceIdOverride?: string): string {
    return execAdb(args, deviceIdOverride ?? this.deviceId);
  }

  private execArgsRaw(args: string[], deviceIdOverride?: string): Buffer {
    return execAdbRaw(args, deviceIdOverride ?? this.deviceId);
  }

  private async execArgsAsync(args: string[], deviceIdOverride?: string): Promise<string> {
    return execAdbAsync(args, deviceIdOverride ?? this.deviceId);
  }

  /**
   * Execute ADB command and return stdout as string.
   * SECURITY: Command is whitespace-split into argv tokens — shell metachars in the input
   * are NOT interpreted (no /bin/sh -c). For commands needing spaces inside an argument
   * (e.g. text input with spaces), use the new argv-form via internal helpers.
   */
  exec(command: string, deviceIdOverride?: string): string {
    return this.execArgs(splitArgs(command), deviceIdOverride);
  }

  /**
   * Execute ADB command and return raw bytes (for screenshots)
   */
  execRaw(command: string, deviceIdOverride?: string): Buffer {
    return this.execArgsRaw(splitArgs(command), deviceIdOverride);
  }

  /**
   * Execute ADB command async (non-blocking)
   */
  async execAsync(command: string, deviceIdOverride?: string): Promise<string> {
    return this.execArgsAsync(splitArgs(command), deviceIdOverride);
  }

  /**
   * Execute ADB command async and return raw bytes (for screenshots)
   */
  async execRawAsync(command: string, deviceIdOverride?: string): Promise<Buffer> {
    return execAdbRawAsync(splitArgs(command), deviceIdOverride ?? this.deviceId);
  }

  /**
   * Get list of connected devices
   */
  getDevices(): Device[] {
    const adbBin = resolveAdbPath();
    const output = execFileSync(adbBin, ["devices", "-l"], { encoding: "utf-8", timeout: EXEC_TIMEOUT_MS });
    return parseDevicesOutput(output);
  }

  /**
   * Set active device
   */
  setDevice(deviceId: string): void {
    validateDeviceId(deviceId);
    this.deviceId = deviceId;
  }

  /**
   * Get currently configured device ID
   */
  getDeviceId(): string | undefined {
    return this.deviceId;
  }

  /**
   * Take screenshot and return raw PNG buffer
   */
  screenshotRaw(): Buffer {
    return this.execRaw("exec-out screencap -p");
  }

  /**
   * Take screenshot async (non-blocking)
   */
  async screenshotRawAsync(): Promise<Buffer> {
    return this.execRawAsync("exec-out screencap -p");
  }

  /**
   * Take screenshot and return as base64 PNG (legacy)
   */
  screenshot(): string {
    return this.screenshotRaw().toString("base64");
  }

  /**
   * Tap at coordinates
   */
  tap(x: number, y: number): void {
    this.exec(`shell input tap ${x} ${y}`);
  }

  /**
   * Double tap at coordinates.
   * Device-side composition via single sh -c argv slot — host shell never parses the metachars.
   * Inputs are validated numerics; user-controlled strings never reach this code path.
   */
  doubleTap(x: number, y: number, intervalMs: number = 100): void {
    const xi = Math.trunc(x);
    const yi = Math.trunc(y);
    const seconds = (Math.max(0, intervalMs) / 1000).toFixed(2);
    const deviceCmd = `input tap ${xi} ${yi} && sleep ${seconds} && input tap ${xi} ${yi}`;
    this.execArgs(["shell", "sh", "-c", deviceCmd]);
  }

  /**
   * Select all text in focused input
   */
  selectAll(): void {
    this.exec("shell input keyevent 256");   // MOVE_HOME
    this.exec("shell input keyevent 268");   // SHIFT+MOVE_END
  }

  /**
   * Copy to clipboard
   */
  copyToClipboard(): void {
    this.exec("shell input keyevent 278");   // KEYCODE_COPY
  }

  /**
   * Paste from clipboard
   */
  pasteFromClipboard(): void {
    this.exec("shell input keyevent 279");   // KEYCODE_PASTE
  }

  /**
   * Get clipboard text
   */
  getClipboardText(): string {
    try {
      return this.exec("shell cmd clipboard get-primary-clip");
    } catch {
      try {
        const result = this.exec("shell am broadcast -a clipper.get");
        return parseClipboardBroadcast(result) ?? "(clipboard not available)";
      } catch {
        return "(clipboard access not available — requires API 29+ or clipper app)";
      }
    }
  }

  /**
   * Long press at coordinates
   */
  longPress(x: number, y: number, durationMs: number = 1000): void {
    this.exec(`shell input swipe ${x} ${y} ${x} ${y} ${durationMs}`);
  }

  /**
   * Swipe gesture
   */
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number = 300): void {
    this.exec(`shell input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);
  }

  /**
   * Swipe in direction (uses screen center)
   */
  swipeDirection(direction: "up" | "down" | "left" | "right", distance: number = 800): void {
    // Get screen size
    const { width, height } = parseScreenSize(this.exec("shell wm size"));

    const centerX = Math.floor(width / 2);
    const centerY = Math.floor(height / 2);

    const coords = {
      up: [centerX, centerY + distance/2, centerX, centerY - distance/2],
      down: [centerX, centerY - distance/2, centerX, centerY + distance/2],
      left: [centerX + distance/2, centerY, centerX - distance/2, centerY],
      right: [centerX - distance/2, centerY, centerX + distance/2, centerY],
    };

    const [x1, y1, x2, y2] = coords[direction];
    this.swipe(x1, y1, x2, y2);
  }

  /**
   * Input text.
   * The full `shell input text "<escaped>"` string passes as a SINGLE argv slot to adb,
   * so the host shell never parses it (host-side CWE-78 closed). adb ships the string
   * verbatim to the device shell, which parses the double-quoted form safely thanks to
   * the per-character escape below.
   */
  inputText(text: string): void {
    const escaped = escapeAndroidInputText(text);
    this.execArgs(["shell", `input text "${escaped}"`]);
  }

  /**
   * Press key by name or keycode
   */
  pressKey(key: string): void {
    const keyCode = resolveKeyCode(key, ANDROID_KEYCODES);
    this.exec(`shell input keyevent ${keyCode}`);
  }

  /**
   * Invalidate the turbo UI tree cache.
   * Call after actions that mutate the screen (tap, swipe, input, etc.)
   * so the next getUiHierarchy call fetches fresh data.
   */
  invalidateUiTreeCache(): void {
    this.uiTreeCache.invalidate();
  }

  /**
   * Get UI hierarchy XML (sync — blocks event loop)
   */
  getUiHierarchy(turbo?: boolean): string {
    if (turbo) {
      const cached = this.uiTreeCache.get();
      if (cached !== null) return cached;
    }

    let xml: string;
    if (turbo) {
      // Single ADB call: pipe XML directly to stdout
      xml = stripDumpPrefix(this.exec("exec-out uiautomator dump /dev/tty"));
    } else {
      this.exec("shell uiautomator dump /sdcard/ui.xml");
      xml = this.exec("shell cat /sdcard/ui.xml");
    }

    this.uiTreeCache.set(xml);
    return xml;
  }

  /**
   * Get UI hierarchy XML async (non-blocking)
   */
  async getUiHierarchyAsync(turbo?: boolean): Promise<string> {
    if (turbo) {
      const cached = this.uiTreeCache.get();
      if (cached !== null) return cached;
    }

    let xml: string;
    if (turbo) {
      // Single ADB call: pipe XML directly to stdout
      xml = stripDumpPrefix(await this.execAsync("exec-out uiautomator dump /dev/tty"));
    } else {
      await this.execAsync("shell uiautomator dump /sdcard/ui.xml");
      xml = await this.execAsync("shell cat /sdcard/ui.xml");
    }

    this.uiTreeCache.set(xml);
    return xml;
  }

  /**
   * Execute an action + uiautomator dump in a single adb shell invocation (turbo only).
   * Reduces two process spawns to one, saving ~150-300ms per step.
   * Returns { actionOutput: string; uiXml: string }.
   *
   * SECURITY: Device-side composition via single sh -c argv slot — host shell never parses
   * the metachars. `actionCommand` originates from internal turbo helpers (tap/swipe/press),
   * which validate numeric inputs; user-controlled strings do not reach this path.
   */
  async execWithUiDump(actionCommand: string, deviceIdOverride?: string): Promise<{ actionOutput: string; uiXml: string }> {
    const combined = `${actionCommand} && uiautomator dump /dev/tty`;
    const raw = await this.execArgsAsync(["shell", "sh", "-c", combined], deviceIdOverride);
    return splitActionAndUiXml(raw);
  }

  /**
   * Tap at coordinates (async, non-blocking — for turbo mode).
   */
  async tapAsync(x: number, y: number, deviceIdOverride?: string): Promise<void> {
    await this.execAsync(`shell input tap ${x} ${y}`, deviceIdOverride);
  }

  /**
   * Swipe gesture (async, non-blocking — for turbo mode).
   */
  async swipeAsync(x1: number, y1: number, x2: number, y2: number, durationMs: number = 300, deviceIdOverride?: string): Promise<void> {
    await this.execAsync(`shell input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`, deviceIdOverride);
  }

  /**
   * Press key (async, non-blocking — for turbo mode).
   */
  async pressKeyAsync(key: string, deviceIdOverride?: string): Promise<void> {
    const keyCode = resolveKeyCode(key, ANDROID_KEYCODES_FAST);
    await this.execAsync(`shell input keyevent ${keyCode}`, deviceIdOverride);
  }

  /**
   * Input text (async, non-blocking — for turbo mode).
   */
  async inputTextAsync(text: string, deviceIdOverride?: string): Promise<void> {
    const escaped = escapeAndroidInputText(text);
    await this.execArgsAsync(["shell", `input text "${escaped}"`], deviceIdOverride);
  }

  /**
   * Launch app by package name
   */
  launchApp(packageName: string): string {
    validatePackageName(packageName);
    // Try to get launch activity
    try {
      const output = this.exec(`shell cmd package resolve-activity --brief ${packageName}`);
      const activity = parseLaunchActivity(output);

      if (activity) {
        this.exec(`shell am start -n ${activity}`);
        return `Launched ${activity}`;
      }
    } catch {
      // Fallback: use monkey to launch
    }

    this.exec(`shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
    return `Launched ${packageName}`;
  }

  /**
   * Stop app
   */
  stopApp(packageName: string): void {
    validatePackageName(packageName);
    this.exec(`shell am force-stop ${packageName}`);
  }

  /**
   * Clear app data
   */
  clearAppData(packageName: string): void {
    validatePackageName(packageName);
    this.exec(`shell pm clear ${packageName}`);
  }

  /**
   * Grant runtime permission to app
   */
  grantPermission(packageName: string, permission: string): void {
    validatePackageName(packageName);
    validatePermission(permission);
    this.exec(`shell pm grant ${packageName} ${permission}`);
  }

  /**
   * Revoke runtime permission from app
   */
  revokePermission(packageName: string, permission: string): void {
    validatePackageName(packageName);
    validatePermission(permission);
    this.exec(`shell pm revoke ${packageName} ${permission}`);
  }

  /**
   * Reset all permissions for app (clears app data)
   */
  resetPermissions(packageName: string): void {
    validatePackageName(packageName);
    this.exec(`shell pm reset-permissions ${packageName}`);
  }

  /**
   * Install APK
   */
  installApk(apkPath: string): string {
    return this.execArgs(["install", "-r", apkPath]);
  }

  /**
   * Uninstall app
   */
  uninstallApp(packageName: string): string {
    validatePackageName(packageName);
    return this.exec(`uninstall ${packageName}`);
  }

  /**
   * Get current activity
   */
  getCurrentActivity(): string {
    try {
      const output = this.exec("shell dumpsys activity activities");
      const resumed = parseCurrentActivityFromActivities(output);
      if (resumed) return resumed;

      // Fallback: try getting current focus from window manager
      const wmOutput = this.exec("shell dumpsys window windows");
      const focused = parseCurrentFocusFromWindows(wmOutput);
      if (focused) return focused;

      return "unknown";
    } catch {
      // Try alternative method — Node-side filter replaces device-side `| grep`.
      try {
        const output = this.execArgs(["shell", "dumpsys", "window"]);
        return parseFocusFromDumpsysWindow(output) ?? "unknown";
      } catch {
        return "unknown (could not determine)";
      }
    }
  }

  /**
   * Get screen size
   */
  getScreenSize(): { width: number; height: number } {
    return parseScreenSize(this.exec("shell wm size"));
  }

  /**
   * Wait for device
   */
  waitForDevice(): void {
    this.exec("wait-for-device");
  }

  /**
   * Execute shell command
   */
  shell(command: string): string {
    return this.exec(`shell ${command}`);
  }

  /**
   * Get device logs (logcat)
   * @param options - filter options
   */
  getLogs(options: LogcatOptions = {}): string {
    const args = buildLogcatArgs(options);
    const output = this.execArgs(args);
    return options.package ? filterLogsByPackage(output, options.package) : output;
  }

  /**
   * Clear logcat buffer
   */
  clearLogs(): void {
    this.exec("logcat -c");
  }

  /**
   * Get network stats (first 100 lines).
   * Node-side filter replaces device-side `| head -100` so we can use argv-form (no shell pipe).
   */
  getNetworkStats(): string {
    const output = this.execArgs(["shell", "dumpsys", "netstats"]);
    return output.split("\n").slice(0, 100).join("\n");
  }

  /**
   * Get battery info
   */
  getBatteryInfo(): string {
    return this.exec("shell dumpsys battery");
  }

  /**
   * Get memory info
   */
  getMemoryInfo(packageName?: string): string {
    if (packageName) {
      validatePackageName(packageName);
      return this.execArgs(["shell", "dumpsys", "meminfo", packageName]);
    }
    const output = this.execArgs(["shell", "cat", "/proc/meminfo"]);
    return output.split("\n").slice(0, 20).join("\n");
  }

  /**
   * Get CPU info (first 20 lines).
   */
  getCpuInfo(): string {
    const output = this.execArgs(["shell", "top", "-n", "1"]);
    return output.split("\n").slice(0, 20).join("\n");
  }
}
