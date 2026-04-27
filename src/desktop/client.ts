/**
 * Desktop Client - communicates with Kotlin companion app via JSON-RPC
 */

import { ChildProcess, spawn, execSync, execFileSync } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { GradleLauncher } from "./gradle.js";
import { validateBundleId, validatePath } from "../utils/sanitize.js";
import { MobileError } from "../errors.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  LaunchOptions,
  RawLaunchOptions,
  LaunchMode,
  LogType,
  ScreenshotOptions,
  ScreenshotResult,
  SwipeOptions,
  KeyEventOptions,
  UiHierarchy,
  WindowInfo,
  DesktopWindow,
  LogEntry,
  LogOptions,
  PerformanceMetrics,
  DesktopState,
  DesktopStatus,
  DesktopUiElement,
  PermissionStatus,
  MonitorInfo,
  MonitorsResult,
  TapByTextResult,
} from "./types.js";

const MAX_RESTARTS = 3;
const REQUEST_TIMEOUT = 45000; // 45 seconds (AppleScript can be slow on macOS with many processes)
const BUNDLE_LAUNCH_POLL_INTERVAL_MS = 100;
const BUNDLE_LAUNCH_TIMEOUT_MS = 5000;

// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Allowed prefixes for appPath (realpath-resolved)
const APP_PATH_ALLOWLIST = [
  "/Applications",
  "/System/Applications",
  path.join(os.homedir(), "Applications"),
  "/Developer",
];

// System processes that must not be attached to
const BLOCKED_COMMS = new Set(["launchd", "kernel_task", "securityd", "loginwindow"]);

/**
 * Normalise a flat RawLaunchOptions into the strict discriminated-union LaunchOptions.
 * Throws on conflicting fields (e.g. mode:"gradle" + pid).
 */
export function normalizeLaunchOptions(raw: RawLaunchOptions): LaunchOptions {
  // Detect conflicting params: mode-specific fields must not bleed across modes
  if (raw.mode === "gradle" && (raw.bundleId !== undefined || raw.appPath !== undefined || raw.pid !== undefined)) {
    throw new MobileError(
      `Conflicting launch parameters: mode "gradle" does not accept bundleId, appPath, or pid`,
      "INVALID_LAUNCH_OPTIONS"
    );
  }
  if (raw.mode === "bundle" && (raw.pid !== undefined || raw.projectPath !== undefined)) {
    throw new MobileError(
      `Conflicting launch parameters: mode "bundle" does not accept pid or projectPath`,
      "INVALID_LAUNCH_OPTIONS"
    );
  }
  if (raw.mode === "attach" && (raw.bundleId !== undefined || raw.appPath !== undefined || raw.projectPath !== undefined)) {
    throw new MobileError(
      `Conflicting launch parameters: mode "attach" does not accept bundleId, appPath, or projectPath`,
      "INVALID_LAUNCH_OPTIONS"
    );
  }

  if (raw.mode) {
    // Explicit mode — build typed object (do not cast)
    switch (raw.mode) {
      case "gradle":
        if (!raw.projectPath) throw new MobileError(`mode "gradle" requires projectPath`, "INVALID_LAUNCH_OPTIONS");
        return { mode: "gradle", projectPath: raw.projectPath, task: raw.task, jvmArgs: raw.jvmArgs, env: raw.env };
      case "bundle":
        return { mode: "bundle", bundleId: raw.bundleId, appPath: raw.appPath };
      case "attach":
        if (raw.pid === undefined) throw new MobileError(`mode "attach" requires pid`, "INVALID_LAUNCH_OPTIONS");
        return { mode: "attach", pid: raw.pid };
      case "companion-only":
        return { mode: "companion-only" };
    }
  }

  // Legacy: infer mode from fields present
  if (raw.projectPath) {
    return { mode: "gradle", projectPath: raw.projectPath, task: raw.task, jvmArgs: raw.jvmArgs, env: raw.env };
  }
  return { mode: "companion-only" };
}

/**
 * Resolve bundleId from an .app path by reading Info.plist via `defaults read`.
 * All calls use execFileSync (no shell).
 */
function getBundleIdFromAppPath(appPath: string): string {
  try {
    const result = execFileSync(
      "defaults",
      ["read", `${appPath}/Contents/Info`, "CFBundleIdentifier"],
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (!result) throw new Error("empty result");
    return result;
  } catch (e: any) {
    throw new MobileError(
      `Could not read bundle ID from ${appPath}/Contents/Info.plist: ${e.message}`,
      "BUNDLE_ID_READ_FAILED"
    );
  }
}

/**
 * Validate an appPath: must be absolute, end with .app, no .., within allowlist (realpath-resolved).
 * Returns the canonicalized path to use when calling `open`.
 */
function validateAndResolveAppPath(appPath: string): string {
  validatePath(appPath, "appPath");
  if (!path.isAbsolute(appPath)) {
    throw new MobileError(`appPath must be an absolute path: ${appPath}`, "INVALID_APP_PATH");
  }
  if (!appPath.endsWith(".app")) {
    throw new MobileError(`appPath must end with .app: ${appPath}`, "INVALID_APP_PATH");
  }
  const resolved = fs.realpathSync(appPath);
  const allowed = APP_PATH_ALLOWLIST.some(prefix => resolved.startsWith(prefix + "/") || resolved === prefix);
  if (!allowed) {
    throw new MobileError(
      `appPath "${resolved}" is outside allowed directories (${APP_PATH_ALLOWLIST.join(", ")})`,
      "APP_PATH_NOT_ALLOWED"
    );
  }
  return resolved;
}

/**
 * Poll AppleScript until the process with the given bundle ID appears, or timeout.
 * All execFileSync calls use argv — no shell, no string interpolation into shell.
 * bundleId is pre-validated by validateBundleId; still safe to embed in AppleScript string
 * because the regex permits only [a-zA-Z0-9.-].
 */
async function resolvePidByBundleId(bundleId: string): Promise<number> {
  const deadline = Date.now() + BUNDLE_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const result = execFileSync(
        "osascript",
        ["-e", `tell application "System Events" to unix id of first application process whose bundle identifier is "${bundleId}"`],
        { encoding: "utf-8", timeout: 3000 }
      ).trim();
      const pid = parseInt(result, 10);
      if (pid > 0) return pid;
    } catch {
      // App not yet running — continue polling
    }
    await new Promise(resolve => setTimeout(resolve, BUNDLE_LAUNCH_POLL_INTERVAL_MS));
  }
  throw new MobileError(
    `App with bundle ID "${bundleId}" did not start within ${BUNDLE_LAUNCH_TIMEOUT_MS}ms`,
    "BUNDLE_LAUNCH_TIMEOUT"
  );
}

/**
 * Validate a PID for safe attach: must be positive, belong to current user, not a system process.
 * Uses separate ps calls to avoid space-split issues with multi-word comm names.
 */
function validateAttachPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new MobileError(`Invalid pid: ${pid}. Must be a positive integer`, "INVALID_PID");
  }

  let uidStr: string;
  let comm: string;
  try {
    uidStr = execFileSync("ps", ["-o", "uid=", "-p", String(pid)], { encoding: "utf-8" }).trim();
    comm = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf-8" }).trim();
  } catch {
    throw new MobileError(`Process with pid ${pid} does not exist`, "PROCESS_NOT_FOUND");
  }

  const uid = parseInt(uidStr, 10);
  const currentUid = process.getuid ? process.getuid() : -1;
  if (currentUid >= 0 && uid !== currentUid) {
    throw new MobileError(`Cannot attach to pid ${pid}: process belongs to another user`, "PID_FOREIGN_USER");
  }

  const basename = path.basename(comm);
  if (BLOCKED_COMMS.has(basename)) {
    throw new MobileError(`Cannot attach to system process: ${basename} (pid ${pid})`, "PID_SYSTEM_PROCESS");
  }
}

/** Strategy interface — returns the targetPid of the launched/attached app, or null. */
interface AppLaunchStrategy {
  launch(): Promise<number | null>;
}

class GradleAppLauncher implements AppLaunchStrategy {
  constructor(
    private readonly opts: Extract<LaunchOptions, { mode: "gradle" }>,
    private readonly gradleLauncher: GradleLauncher,
    private readonly addLog: (type: LogType, msg: string) => void
  ) {}

  async launch(): Promise<number | null> {
    this.addLog("stdout", `Launching user app from: ${this.opts.projectPath}`);
    const userAppProcess = this.gradleLauncher.launch(this.opts as any);
    userAppProcess.stdout?.on("data", (data: Buffer) => this.addLog("stdout", `[UserApp] ${data.toString()}`));
    userAppProcess.stderr?.on("data", (data: Buffer) => this.addLog("stderr", `[UserApp] ${data.toString()}`));
    return null;
  }
}

class BundleAppLauncher implements AppLaunchStrategy {
  constructor(
    private readonly opts: Extract<LaunchOptions, { mode: "bundle" }>,
    private readonly addLog: (type: LogType, msg: string) => void
  ) {}

  async launch(): Promise<number | null> {
    const { bundleId, appPath } = this.opts;
    if (!bundleId && !appPath) {
      throw new MobileError(`mode "bundle" requires bundleId or appPath`, "INVALID_LAUNCH_OPTIONS");
    }

    let resolvedBundleId: string;

    if (bundleId) {
      validateBundleId(bundleId);
      resolvedBundleId = bundleId;
      this.addLog("stdout", `Launching app by bundle ID: ${resolvedBundleId}`);
      execFileSync("open", ["-b", resolvedBundleId], { timeout: 5000 });
    } else {
      const resolvedPath = validateAndResolveAppPath(appPath!);
      resolvedBundleId = getBundleIdFromAppPath(resolvedPath);
      validateBundleId(resolvedBundleId);
      this.addLog("stdout", `Launching app: ${resolvedPath} (bundle ID: ${resolvedBundleId})`);
      // Pass the realpath-resolved path to `open` to prevent TOCTOU
      execFileSync("open", [resolvedPath], { timeout: 5000 });
    }

    this.addLog("stdout", `Waiting for app to start (polling every ${BUNDLE_LAUNCH_POLL_INTERVAL_MS}ms)...`);
    const targetPid = await resolvePidByBundleId(resolvedBundleId);
    this.addLog("stdout", `App started with PID ${targetPid}`);
    return targetPid;
  }
}

class AttachLauncher implements AppLaunchStrategy {
  constructor(
    private readonly opts: Extract<LaunchOptions, { mode: "attach" }>,
    private readonly addLog: (type: LogType, msg: string) => void
  ) {}

  async launch(): Promise<number | null> {
    validateAttachPid(this.opts.pid);
    this.addLog("stdout", `Attaching to existing process with PID ${this.opts.pid}`);
    return this.opts.pid;
  }
}

class NoOpLauncher implements AppLaunchStrategy {
  async launch(): Promise<number | null> {
    return null;
  }
}

/**
 * Find the companion app path
 */
function findCompanionAppPath(): string {
  // Look for companion app relative to this module
  // The installed distribution is at desktop-companion/build/install/desktop-companion/bin/desktop-companion
  const possiblePaths = [
    // From dist/desktop/client.js
    path.join(__dirname, "..", "..", "desktop-companion", "build", "install", "desktop-companion", "bin", "desktop-companion"),
    // From src/desktop/client.ts (when running directly)
    path.join(__dirname, "..", "..", "..", "desktop-companion", "build", "install", "desktop-companion", "bin", "desktop-companion"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error(
    "Desktop companion app not found. Please build it first: cd desktop-companion && ./gradlew installDist"
  );
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class DesktopClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private gradleLauncher: GradleLauncher;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private logs: LogEntry[] = [];
  private maxLogs = 10000;
  private state: DesktopState = {
    status: "stopped",
    crashCount: 0,
  };
  private lastLaunchOptions: RawLaunchOptions | null = null;
  private readline: readline.Interface | null = null;

  constructor() {
    super();
    this.gradleLauncher = new GradleLauncher();
  }

  /**
   * Get current state
   */
  getState(): DesktopState {
    return { ...this.state };
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.state.status === "running" && this.process !== null && !this.process.killed;
  }

  /**
   * Launch desktop automation. Accepts the flat RawLaunchOptions (backward-compatible)
   * and normalizes internally to the discriminated-union LaunchOptions.
   */
  async launch(options: RawLaunchOptions): Promise<void> {
    if (this.isRunning()) {
      throw new Error("Desktop companion is already running. Stop it first.");
    }

    const normalized = normalizeLaunchOptions(options);
    this.lastLaunchOptions = options;
    this.state = {
      status: "starting",
      projectPath: normalized.mode === "gradle" ? normalized.projectPath : undefined,
      crashCount: this.state.crashCount,
    };

    try {
      const companionPath = findCompanionAppPath();
      this.addLog("stdout", `Starting companion app: ${companionPath}`);

      this.process = spawn(companionPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          JAVA_HOME: process.env.JAVA_HOME || execSync("/usr/libexec/java_home -v 21 2>/dev/null || /usr/libexec/java_home 2>/dev/null || echo ''").toString().trim(),
        },
      });
      this.state.pid = this.process.pid;

      if (this.process.stdout) {
        this.readline = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity });
        this.readline.on("line", (line) => this.handleLine(line));
      }

      if (this.process.stderr) {
        this.process.stderr.on("data", (data: Buffer) => {
          const message = data.toString();
          this.addLog("stderr", message);
          if (message.includes("Desktop companion ready") || message.includes("JsonRpcServer started")) {
            this.state.status = "running";
            this.emit("ready");
          }
        });
      }

      this.process.on("exit", (code, signal) => this.handleExit(code, signal));
      this.process.on("error", (error) => {
        this.addLog("crash", `Process error: ${error.message}`);
        this.handleCrash(error);
      });

      await this.waitForReady(10000);

      const strategy = this.selectStrategy(normalized);
      const targetPid = await strategy.launch();
      this.state.targetPid = targetPid ?? undefined;

    } catch (error: unknown) {
      this.state.status = "stopped";
      this.state.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private selectStrategy(opts: LaunchOptions): AppLaunchStrategy {
    switch (opts.mode) {
      case "gradle":
        return new GradleAppLauncher(opts, this.gradleLauncher, this.addLog.bind(this));
      case "bundle":
        return new BundleAppLauncher(opts, this.addLog.bind(this));
      case "attach":
        return new AttachLauncher(opts, this.addLog.bind(this));
      case "companion-only":
        return new NoOpLauncher();
    }
  }

  getTargetPid(): number | null {
    return this.state.targetPid ?? null;
  }

  /**
   * Wait for the companion app to be ready
   */
  private waitForReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Consider ready even without explicit signal after timeout
        // The app might not send a ready signal
        if (this.process && !this.process.killed) {
          this.state.status = "running";
          resolve();
        } else {
          reject(new Error("Desktop app failed to start"));
        }
      }, timeoutMs);

      this.once("ready", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.process?.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Desktop app exited before becoming ready"));
      });
    });
  }

  /**
   * Stop desktop app
   */
  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    // Clean up readline
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Desktop app stopped"));
    }
    this.pendingRequests.clear();

    // Stop process
    this.gradleLauncher.stop(this.process);
    this.process = null;

    this.state = {
      status: "stopped",
      crashCount: 0,
    };
  }

  /**
   * Handle incoming line from stdout
   */
  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Try to parse as JSON-RPC response
    if (trimmed.startsWith("{")) {
      try {
        const response: JsonRpcResponse = JSON.parse(trimmed);
        this.handleResponse(response);
        return;
      } catch {
        // Not JSON, treat as log
      }
    }

    // Regular log output
    this.addLog("stdout", trimmed);
  }

  /**
   * Handle JSON-RPC response
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return; // Unknown response
    }

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timeout);

    if (response.error) {
      pending.reject(new Error(`${response.error.message} (code: ${response.error.code})`));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Handle process exit
   */
  private handleExit(code: number | null, signal: string | null): void {
    const wasRunning = this.state.status === "running";

    if (code !== 0 && wasRunning) {
      this.addLog("crash", `Process exited with code ${code}, signal ${signal}`);
      this.handleCrash(new Error(`Exit code: ${code}`));
    } else {
      this.state.status = "stopped";
    }

    this.process = null;
  }

  /**
   * Handle crash with auto-restart
   */
  private async handleCrash(error: Error): Promise<void> {
    this.state.status = "crashed";
    this.state.crashCount++;
    this.state.lastError = error.message;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Desktop app crashed"));
    }
    this.pendingRequests.clear();

    // Auto-restart if under limit
    if (this.state.crashCount <= MAX_RESTARTS && this.lastLaunchOptions) {
      console.error(
        `Desktop app crashed, restarting (${this.state.crashCount}/${MAX_RESTARTS})...`
      );

      try {
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait before restart
        await this.launch(this.lastLaunchOptions);
      } catch (restartError: any) {
        console.error(`Failed to restart: ${restartError.message}`);
      }
    } else {
      this.emit("crash", error);
    }
  }

  /**
   * Send JSON-RPC request
   */
  private async sendRequest<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.isRunning() || !this.process?.stdin) {
      throw new Error("Desktop app is not running");
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      const json = JSON.stringify(request);
      this.process!.stdin!.write(json + "\n");
    });
  }

  /**
   * Add log entry
   */
  private addLog(type: LogEntry["type"], message: string): void {
    this.logs.push({
      timestamp: Date.now(),
      type,
      message,
    });

    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  // ============ Public API Methods ============

  /**
   * Take screenshot
   */
  async screenshotRaw(options?: ScreenshotOptions): Promise<Buffer> {
    const result = await this.sendRequest<ScreenshotResult>("screenshot", options as Record<string, unknown>);
    return Buffer.from(result.base64, "base64");
  }

  /**
   * Take screenshot and return base64
   */
  async screenshot(options?: ScreenshotOptions): Promise<string> {
    const result = await this.sendRequest<ScreenshotResult>("screenshot", options as Record<string, unknown>);
    return result.base64;
  }

  /**
   * Get screenshot with metadata
   */
  async screenshotWithMeta(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    return this.sendRequest<ScreenshotResult>("screenshot", options as Record<string, unknown>);
  }

  /**
   * Tap at coordinates
   * @param targetPid - Optional PID to send click without stealing focus (macOS only)
   */
  async tap(x: number, y: number, targetPid?: number): Promise<void> {
    await this.sendRequest("tap", { x, y, targetPid });
  }

  /**
   * Tap an element by its text content using Accessibility API
   * This does NOT move the cursor - perfect for background automation (macOS only)
   * @param text - The text to search for (partial match, case-insensitive)
   * @param pid - The process ID of the target application
   * @param exactMatch - If true, requires exact text match
   */
  async tapByText(text: string, pid: number, exactMatch: boolean = false): Promise<TapByTextResult> {
    return this.sendRequest<TapByTextResult>("tap_by_text", { text, pid, exactMatch });
  }

  /**
   * Long press at coordinates
   */
  async longPress(x: number, y: number, durationMs: number = 1000): Promise<void> {
    await this.sendRequest("long_press", { x, y, durationMs });
  }

  /**
   * Swipe gesture
   */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number = 300): Promise<void> {
    await this.sendRequest("swipe", { x1, y1, x2, y2, durationMs });
  }

  /**
   * Swipe in direction
   */
  async swipeDirection(direction: "up" | "down" | "left" | "right", distance?: number): Promise<void> {
    await this.sendRequest("swipe_direction", { direction, distance });
  }

  /**
   * Input text
   * @param targetPid - Optional PID to send input without stealing focus (macOS only)
   */
  async inputText(text: string, targetPid?: number): Promise<void> {
    await this.sendRequest("input_text", { text, targetPid });
  }

  /**
   * Press key
   * @param targetPid - Optional PID to send key without stealing focus (macOS only)
   */
  async pressKey(key: string, modifiers?: string[], targetPid?: number): Promise<void> {
    await this.sendRequest("key_event", { key, modifiers, targetPid });
  }

  /**
   * Get the PID of the focused window (for background input)
   */
  async getFocusedWindowPid(): Promise<number | null> {
    const info = await this.getWindowInfo();
    const focused = info.windows.find((w: DesktopWindow) => w.focused);
    return focused?.processId ?? null;
  }

  /**
   * Get UI hierarchy
   */
  async getUiHierarchy(windowId?: string): Promise<UiHierarchy> {
    return this.sendRequest<UiHierarchy>("get_ui_hierarchy", { windowId });
  }

  /**
   * Get UI hierarchy as XML string (for compatibility)
   */
  getUiHierarchyXml(): string {
    // Not supported - desktop uses accessibility tree
    throw new Error("XML hierarchy not supported for desktop. Use getUiHierarchy() instead.");
  }

  /**
   * Get window information
   */
  async getWindowInfo(): Promise<WindowInfo> {
    return this.sendRequest<WindowInfo>("get_window_info");
  }

  /**
   * Focus a window
   */
  async focusWindow(windowId: string): Promise<void> {
    await this.sendRequest("focus_window", { windowId });
  }

  /**
   * Resize a window
   */
  async resizeWindow(width: number, height: number, windowId?: string): Promise<void> {
    await this.sendRequest("resize_window", { windowId, width, height });
  }

  /**
   * Get clipboard content
   */
  async getClipboard(): Promise<string> {
    const result = await this.sendRequest<{ text: string }>("get_clipboard");
    return result.text ?? "";
  }

  /**
   * Set clipboard content
   */
  async setClipboard(text: string): Promise<void> {
    await this.sendRequest("set_clipboard", { text });
  }

  /**
   * Check accessibility permissions
   */
  async checkPermissions(): Promise<PermissionStatus> {
    return this.sendRequest<PermissionStatus>("check_permissions");
  }

  /**
   * Get logs
   */
  getLogs(options?: LogOptions): LogEntry[] {
    let result = [...this.logs];

    if (options?.type) {
      result = result.filter((log) => log.type === options.type);
    }

    if (options?.since) {
      result = result.filter((log) => log.timestamp >= options.since!);
    }

    if (options?.limit) {
      result = result.slice(-options.limit);
    }

    return result;
  }

  /**
   * Clear logs
   */
  clearLogs(): void {
    this.logs = [];
  }

  /**
   * Get performance metrics
   */
  async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    return this.sendRequest<PerformanceMetrics>("get_performance_metrics");
  }

  /**
   * Get screen size
   */
  async getScreenSize(): Promise<{ width: number; height: number }> {
    const info = await this.getWindowInfo();
    if (info.windows.length > 0) {
      const focused = info.windows.find((w) => w.focused) ?? info.windows[0];
      return {
        width: focused.bounds.width,
        height: focused.bounds.height,
      };
    }
    return { width: 1920, height: 1080 }; // Default
  }

  /**
   * Get list of connected monitors (multi-monitor support)
   */
  async getMonitors(): Promise<MonitorInfo[]> {
    const result = await this.sendRequest<MonitorsResult>("get_monitors");
    return result.monitors;
  }

  /**
   * Launch app (for compatibility with mobile interface)
   */
  launchApp(packageName: string): string {
    return `Desktop platform doesn't support package launch. Use desktop_launch to start an app.`;
  }

  /**
   * Stop app (for compatibility)
   */
  stopApp(packageName: string): void {
    // No-op for desktop
  }

  /**
   * Shell command (not supported)
   */
  shell(command: string): string {
    throw new Error("Shell commands not supported for desktop. Use native APIs.");
  }
}

// Export singleton instance
export const desktopClient = new DesktopClient();
