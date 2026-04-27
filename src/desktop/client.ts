/**
 * Desktop Client - communicates with Kotlin companion app via JSON-RPC
 */

import { ChildProcess, spawn, execSync, execFileSync, execFile } from "child_process";
import { promisify } from "util";
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

const execFileAsync = promisify(execFile);

// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Allowed prefixes for appPath (realpath-resolved)
const APP_PATH_ALLOWLIST = [
  "/Applications",
  "/System/Applications",
  path.join(os.homedir(), "Applications"),
  "/Developer",
  path.join(os.homedir(), "Library/Developer/Xcode/DerivedData"),
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
        if (!raw.bundleId && !raw.appPath) throw new MobileError(`mode "bundle" requires bundleId or appPath`, "INVALID_LAUNCH_OPTIONS");
        // After the check, at least one is defined — split to satisfy the XOR union type
        if (raw.bundleId) {
          return { mode: "bundle", bundleId: raw.bundleId, appPath: raw.appPath, env: raw.env };
        }
        return { mode: "bundle", appPath: raw.appPath!, env: raw.env };
      case "attach":
        if (raw.pid === undefined) throw new MobileError(`mode "attach" requires pid`, "INVALID_LAUNCH_OPTIONS");
        return { mode: "attach", pid: raw.pid };
      case "companion-only":
        return { mode: "companion-only" };
      default:
        throw new MobileError(
          `Unknown launch mode: "${raw.mode}". Valid values: gradle, bundle, attach, companion-only`,
          "INVALID_LAUNCH_OPTIONS"
        );
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
 * Uses execFileAsync (non-blocking) so the event loop is not held during the 3s osascript call.
 * bundleId is pre-validated by validateBundleId; regex permits only [a-zA-Z0-9.-].
 * AppleScript injection prevention relies on this regex — do not relax without re-auditing.
 */
async function resolvePidByBundleId(bundleId: string): Promise<number> {
  const deadline = Date.now() + BUNDLE_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(
        "osascript",
        ["-e", `tell application "System Events" to unix id of first application process whose bundle identifier is "${bundleId}"`],
        { timeout: 3000 }
      );
      const pid = parseInt(stdout.trim(), 10);
      if (pid > 0) return pid;
    } catch (e: any) {
      const stderr: string = e.stderr ?? "";
      // Non-transient: permission denial from System Events will never self-resolve
      if (stderr.includes("Not authorized") || stderr.includes("-1743")) {
        throw new MobileError(
          `Accessibility permission denied. Grant access in System Settings → Privacy → Automation.`,
          "AUTOMATION_PERMISSION_DENIED"
        );
      }
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

  let psOut: string;
  try {
    psOut = execFileSync("ps", ["-o", "uid=,comm=", "-p", String(pid)], { encoding: "utf-8" }).trim();
  } catch (e: any) {
    if (e.status === 1) {
      throw new MobileError(`Process with pid ${pid} does not exist`, "PROCESS_NOT_FOUND");
    }
    throw new MobileError(`Failed to inspect pid ${pid}: ${e.message}`, "PS_EXEC_FAILED");
  }

  // uid= and comm= are separated by whitespace; comm= may contain spaces — split on first whitespace only
  const spaceIdx = psOut.search(/\s/);
  const uidStr = spaceIdx >= 0 ? psOut.slice(0, spaceIdx) : psOut;
  const comm = spaceIdx >= 0 ? psOut.slice(spaceIdx + 1).trim() : "";

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
  stop(): void;
}

class GradleAppLauncher implements AppLaunchStrategy {
  private userAppProcess: ChildProcess | null = null;

  constructor(
    private readonly opts: Extract<LaunchOptions, { mode: "gradle" }>,
    private readonly gradleLauncher: GradleLauncher,
    private readonly addLog: (type: LogType, msg: string) => void
  ) {}

  async launch(): Promise<number | null> {
    this.addLog("stdout", `Launching user app from: ${this.opts.projectPath}`);
    // Spread to satisfy RawLaunchOptions (no as any — structural types are compatible)
    this.userAppProcess = this.gradleLauncher.launch({ ...this.opts });
    this.userAppProcess.stdout?.on("data", (data: Buffer) => this.addLog("stdout", `[UserApp] ${data.toString()}`));
    this.userAppProcess.stderr?.on("data", (data: Buffer) => this.addLog("stderr", `[UserApp] ${data.toString()}`));
    return null;
  }

  stop(): void {
    if (this.userAppProcess) {
      this.gradleLauncher.stop(this.userAppProcess);
      this.userAppProcess = null;
    }
  }
}

class BundleAppLauncher implements AppLaunchStrategy {
  stop(): void {}

  constructor(
    private readonly opts: Extract<LaunchOptions, { mode: "bundle" }>,
    private readonly addLog: (type: LogType, msg: string) => void
  ) {}

  async launch(): Promise<number | null> {
    // Both bundleId and appPath are pre-validated by normalizeLaunchOptions — at least one is set.
    const { bundleId, appPath, env } = this.opts;
    const hasEnv = env && Object.keys(env).length > 0;
    let resolvedBundleId: string;
    let resolvedPath: string | undefined;

    if (bundleId) {
      validateBundleId(bundleId);
      resolvedBundleId = bundleId;
    } else {
      resolvedPath = validateAndResolveAppPath(appPath!);
      resolvedBundleId = getBundleIdFromAppPath(resolvedPath);
      validateBundleId(resolvedBundleId);
    }

    this.addLog("stdout", `Launching app: ${bundleId ?? resolvedPath}${hasEnv ? ` (with env: ${Object.keys(env!).join(", ")})` : ""}`);

    if (hasEnv) {
      // `open` cannot pass env vars to the launched app — spawn the binary directly.
      // resolvedPath is always set when env is used with appPath; derive it from bundleId otherwise.
      const appPath_ = resolvedPath ?? this.getAppPathFromBundleId(resolvedBundleId);
      const binaryName = execFileSync(
        "defaults", ["read", `${appPath_}/Contents/Info`, "CFBundleExecutable"],
        { encoding: "utf-8", timeout: 3000 }
      ).trim();
      const binaryPath = `${appPath_}/Contents/MacOS/${binaryName}`;
      spawn(binaryPath, [], {
        env: { ...process.env, ...env },
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      // No env vars needed — use `open` (proper app launch via LaunchServices)
      try {
        if (resolvedPath) {
          // Pass the realpath-resolved path to `open` to prevent TOCTOU
          execFileSync("open", [resolvedPath], { timeout: 5000 });
        } else {
          execFileSync("open", ["-b", resolvedBundleId], { timeout: 5000 });
        }
      } catch (e: any) {
        throw new MobileError(`Failed to launch app "${bundleId ?? resolvedPath}": ${e.message}`, "BUNDLE_LAUNCH_FAILED");
      }
    }

    this.addLog("stdout", `Waiting for app to start (polling every ${BUNDLE_LAUNCH_POLL_INTERVAL_MS}ms)...`);
    const targetPid = await resolvePidByBundleId(resolvedBundleId);
    this.addLog("stdout", `App started with PID ${targetPid}`);
    return targetPid;
  }

  private getAppPathFromBundleId(bundleId: string): string {
    try {
      const result = execFileSync(
        "osascript", ["-e", `POSIX path of (path to application id "${bundleId}")`],
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      // Strip trailing slash that osascript adds
      return result.replace(/\/$/, "");
    } catch (e: any) {
      throw new MobileError(`Cannot find app path for bundle ID "${bundleId}": ${e.message}`, "BUNDLE_PATH_NOT_FOUND");
    }
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

  stop(): void {}
}

class NoOpLauncher implements AppLaunchStrategy {
  async launch(): Promise<number | null> { return null; }
  stop(): void {}
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
  private activeStrategy: AppLaunchStrategy | null = null;
  private gradleLauncher: GradleLauncher;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private logs: LogEntry[] = [];
  private maxLogs = 10000;
  private state: DesktopState = {
    status: "stopped",
    crashCount: 0,
    targetPid: null,
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
      targetPid: null,
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

      this.activeStrategy = this.selectStrategy(normalized);
      const targetPid = await this.activeStrategy.launch();
      this.state.targetPid = targetPid;

    } catch (error: unknown) {
      // Kill companion if it was spawned before strategy failure (prevents orphan processes)
      if (this.process && !this.process.killed) {
        this.process.kill();
      }
      if (this.readline) {
        this.readline.close();
        this.readline = null;
      }
      this.process = null;
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
    return this.state.targetPid;
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

    // Stop any app process managed by the active strategy (e.g. Gradle child)
    this.activeStrategy?.stop();
    this.activeStrategy = null;

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
      targetPid: null,
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
