/**
 * Desktop Client - communicates with Kotlin companion app via JSON-RPC
 */

import { ChildProcess, spawn, execFileSync } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import { GradleLauncher } from "./gradle.js";
import { findCompanionAppPath } from "./permission-allowlist.js";
import { LogRing } from "./log-ring.js";
import { normalizeLaunchOptions } from "./launch-options.js";
import { DESKTOP } from "mcp-devices/constants/timeouts";
import {
  AttachLauncher,
  BundleAppLauncher,
  GradleAppLauncher,
  NoOpLauncher,
  type AppLaunchStrategy,
} from "./launchers.js";

// Re-export module-scoped helpers so existing imports of `src/desktop/client.js` keep working.
export {
  APP_PATH_ALLOWLIST,
  BLOCKED_COMMS,
  findCompanionAppPath,
  getBundleIdFromAppPath,
  resolvePidByBundleId,
  validateAndResolveAppPath,
  validateAttachPid,
} from "./permission-allowlist.js";
export { LogRing } from "./log-ring.js";
export { normalizeLaunchOptions } from "./launch-options.js";
export {
  AttachLauncher,
  BundleAppLauncher,
  GradleAppLauncher,
  NoOpLauncher,
  type AppLaunchStrategy,
} from "./launchers.js";
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
  private readonly logRing = new LogRing(10_000);
  private state: DesktopState = {
    status: "stopped",
    crashCount: 0,
    targetPid: null,
  };
  private lastLaunchOptions: RawLaunchOptions | null = null;
  private readline: readline.Interface | null = null;

  /** PID of the user's app — set after native launch or attach. Auto-passed to tap/input/key. */
  targetPid: number | undefined;

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
          JAVA_HOME: process.env.JAVA_HOME || (() => {
            if (process.platform !== "darwin") return "";
            try {
              return execFileSync("/usr/libexec/java_home", ["-v", "21"], { encoding: "utf-8", timeout: 3000 }).trim();
            } catch {
              try {
                return execFileSync("/usr/libexec/java_home", [], { encoding: "utf-8", timeout: 3000 }).trim();
              } catch { return ""; }
            }
          })(),
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
      const cleanup = () => {
        clearTimeout(timeout);
        this.removeListener("ready", onReady);
        this.process?.removeListener("exit", onExit);
      };

      const onReady = () => {
        cleanup();
        resolve();
      };

      const onExit = () => {
        cleanup();
        reject(new Error("Desktop app exited before becoming ready"));
      };

      const timeout = setTimeout(() => {
        cleanup();
        // Consider ready even without explicit signal after timeout
        // The app might not send a ready signal
        if (this.process && !this.process.killed) {
          this.state.status = "running";
          resolve();
        } else {
          reject(new Error("Desktop app failed to start"));
        }
      }, timeoutMs);

      this.once("ready", onReady);
      this.process?.once("exit", onExit);
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
    this.targetPid = undefined;

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
   * Detach the old (dead/dying) companion process and its associated handles
   * so they don't linger until GC when launch() respawns a replacement.
   * Safe to call when there's nothing to detach.
   */
  private detachProcess(): void {
    if (this.readline) {
      this.readline.removeAllListeners();
      this.readline.close();
      this.readline = null;
    }

    const old = this.process;
    if (old) {
      old.stdout?.removeAllListeners();
      old.stderr?.removeAllListeners();
      old.removeAllListeners();
      if (!old.killed) {
        old.kill();
      }
      this.process = null;
    }
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

    // Detach the crashed process + its listeners/readline before respawning,
    // otherwise the old handles linger until GC (M3).
    this.detachProcess();

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
      }, DESKTOP.RPC_TIMEOUT_MS);

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
   * Add log entry (delegates to LogRing)
   */
  private addLog(type: LogEntry["type"], message: string): void {
    this.logRing.push(type, message);
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
    await this.sendRequest("tap", { x, y, targetPid: targetPid ?? this.targetPid });
  }

  /**
   * Tap an element by its text content using Accessibility API
   * This does NOT move the cursor - perfect for background automation (macOS only)
   * @param text - The text to search for (partial match, case-insensitive)
   * @param pid - The process ID of the target application
   * @param exactMatch - If true, requires exact text match
   */
  async tapByText(text: string, pid?: number, exactMatch: boolean = false): Promise<TapByTextResult> {
    const resolvedPid = pid ?? this.targetPid;
    if (resolvedPid === undefined) {
      throw new Error("No target PID. Launch a native app (bundleId/appPath) or pass pid explicitly.");
    }
    return this.sendRequest<TapByTextResult>("tap_by_text", { text, pid: resolvedPid, exactMatch });
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
    await this.sendRequest("input_text", { text, targetPid: targetPid ?? this.targetPid });
  }

  /**
   * Press key
   * @param targetPid - Optional PID to send key without stealing focus (macOS only)
   */
  async pressKey(key: string, modifiers?: string[], targetPid?: number): Promise<void> {
    await this.sendRequest("key_event", { key, modifiers, targetPid: targetPid ?? this.targetPid });
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
    return this.logRing.query(options);
  }

  /**
   * Clear logs
   */
  clearLogs(): void {
    this.logRing.clear();
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
   * Launch app by bundle ID (for compatibility with mobile interface).
   * If companion is running, launches native macOS app and resolves PID.
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
