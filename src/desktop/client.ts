/**
 * Desktop Client - communicates with Kotlin companion app via JSON-RPC
 */

import { ChildProcess, spawn, execSync, execFileSync } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { GradleLauncher } from "./gradle.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  LaunchOptions,
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

// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  private lastLaunchOptions: LaunchOptions | null = null;
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
   * Launch desktop automation (starts companion app, optionally launches user's app via Gradle)
   */
  async launch(options: LaunchOptions): Promise<void> {
    if (this.isRunning()) {
      throw new Error("Desktop companion is already running. Stop it first.");
    }

    this.lastLaunchOptions = options;
    this.state = {
      status: "starting",
      projectPath: options.projectPath,
      crashCount: this.state.crashCount,
    };

    try {
      // Find and start the companion app
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

      // Launch user's app based on mode
      if (options.projectPath) {
        // Gradle mode — Compose Desktop app
        this.addLog("stdout", `Launching user app from: ${options.projectPath}`);
        const userAppProcess = this.gradleLauncher.launch(options);
        userAppProcess.stdout?.on("data", (data: Buffer) => {
          this.addLog("stdout", `[UserApp] ${data.toString()}`);
        });
        userAppProcess.stderr?.on("data", (data: Buffer) => {
          this.addLog("stderr", `[UserApp] ${data.toString()}`);
        });
      } else if (options.bundleId || options.appPath) {
        // Native mode — macOS .app bundle
        this.addLog("stdout", `Launching native app: ${options.bundleId || options.appPath}`);
      } else if (options.pid) {
        // Attach mode — existing process
        this.addLog("stdout", `Attaching to process PID: ${options.pid}`);
      }

      // Set up stdout for JSON-RPC responses
      if (this.process.stdout) {
        this.readline = readline.createInterface({
          input: this.process.stdout,
          crlfDelay: Infinity,
        });

        this.readline.on("line", (line) => {
          this.handleLine(line);
        });
      }

      // Capture stderr for logs
      if (this.process.stderr) {
        this.process.stderr.on("data", (data: Buffer) => {
          const message = data.toString();
          this.addLog("stderr", message);

          // Check for "ready" signal or specific patterns
          if (message.includes("Desktop companion ready") ||
              message.includes("JsonRpcServer started")) {
            this.state.status = "running";
            this.emit("ready");
          }
        });
      }

      // Handle process exit
      this.process.on("exit", (code, signal) => {
        this.handleExit(code, signal);
      });

      this.process.on("error", (error) => {
        this.addLog("crash", `Process error: ${error.message}`);
        this.handleCrash(error);
      });

      // Wait for ready signal or timeout
      await this.waitForReady(10000);

      // After companion is ready, handle native/attach modes
      if (options.bundleId || options.appPath) {
        await this.launchNativeApp(options.bundleId, options.appPath);
      } else if (options.pid) {
        await this.attachToProcess(options.pid);
      }

    } catch (error: unknown) {
      this.state.status = "stopped";
      this.state.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
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
    this.targetPid = undefined;

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

  // ============ Native Launch / Attach ============

  /**
   * Launch a native macOS app by bundle ID or .app path, resolve its PID.
   */
  private async launchNativeApp(bundleId?: string, appPath?: string): Promise<void> {
    try {
      if (bundleId) {
        execFileSync("open", ["-b", bundleId]);
      } else if (appPath) {
        execFileSync("open", ["-a", appPath]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to launch native app: ${msg}`);
    }

    // Wait for app process to appear
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Resolve PID
    const identifier = bundleId || appPath!;
    const pids = this.resolveProcessesByBundleId(bundleId);
    if (pids.length === 0 && appPath) {
      // Fallback: try pgrep with app name
      const appName = path.basename(appPath, ".app");
      try {
        const output = execFileSync("pgrep", ["-f", appName], { encoding: "utf-8" }).trim();
        if (output) {
          pids.push(...output.split("\n").map(Number).filter(Boolean));
        }
      } catch {
        // pgrep returns exit code 1 when no matches
      }
    }

    if (pids.length === 1) {
      this.targetPid = pids[0];
      this.addLog("stdout", `Native app PID: ${this.targetPid}`);
    } else if (pids.length > 1) {
      // Multiple instances — use most recent (highest PID is heuristic for newest)
      this.targetPid = Math.max(...pids);
      this.addLog("stdout", `Multiple instances found (PIDs: ${pids.join(", ")}), using ${this.targetPid}`);
    } else {
      this.addLog("stderr", `Warning: could not resolve PID for ${identifier}. Input will not auto-target.`);
    }

    // Check AX permissions
    try {
      const perms = await this.checkPermissions();
      if (!perms.granted) {
        this.addLog("stderr", "Accessibility permissions not granted. Input actions may fail.");
      }
    } catch {
      // Companion may not support check_permissions yet
    }
  }

  /**
   * Attach to an already-running process by PID.
   */
  private async attachToProcess(pid: number): Promise<void> {
    // Verify process exists (kill -0 sends no signal, just checks)
    try {
      process.kill(pid, 0);
    } catch {
      throw new Error(`Process ${pid} does not exist or is not accessible`);
    }
    this.targetPid = pid;
    this.addLog("stdout", `Attached to process PID: ${pid}`);

    try {
      const perms = await this.checkPermissions();
      if (!perms.granted) {
        this.addLog("stderr", "Accessibility permissions not granted. Input actions may fail.");
      }
    } catch {
      // Companion may not support check_permissions yet
    }
  }

  /**
   * Resolve PIDs for a macOS bundle ID using lsappinfo.
   */
  private resolveProcessesByBundleId(bundleId?: string): number[] {
    if (!bundleId) return [];
    try {
      const output = execFileSync(
        "lsappinfo", ["info", "-only", "pid", "-app", bundleId],
        { encoding: "utf-8" }
      ).trim();
      // Output format: "pid" = 12345 or "pid" = { 123, 456 }
      const matches = output.match(/\d+/g);
      if (matches) {
        return matches.map(Number).filter((n) => n > 0);
      }
    } catch {
      // lsappinfo may not find the app
    }

    // Fallback: pgrep
    try {
      const output = execFileSync("pgrep", ["-f", bundleId], { encoding: "utf-8" }).trim();
      if (output) {
        return output.split("\n").map(Number).filter(Boolean);
      }
    } catch {
      // No matches
    }

    return [];
  }

  /**
   * Resolve all running instances of a bundle ID with window info.
   * Useful when multiple instances exist and user needs to pick one.
   */
  async resolveProcesses(bundleId: string): Promise<Array<{ pid: number; windows: string[] }>> {
    const pids = this.resolveProcessesByBundleId(bundleId);
    const results: Array<{ pid: number; windows: string[] }> = [];

    for (const pid of pids) {
      let windows: string[] = [];
      if (this.isRunning()) {
        try {
          const info = await this.getWindowInfo();
          windows = info.windows
            .filter((w: DesktopWindow) => w.processId === pid)
            .map((w: DesktopWindow) => w.title);
        } catch {
          // Companion may not be running
        }
      }
      results.push({ pid, windows });
    }

    return results;
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
   * Launch app by bundle ID (for compatibility with mobile interface).
   * If companion is running, launches native macOS app and resolves PID.
   */
  async launchApp(bundleId: string): Promise<string> {
    if (!this.isRunning()) {
      return `Desktop companion not running. Use desktop(action:'launch', bundleId:'${bundleId}') to start.`;
    }
    try {
      await this.launchNativeApp(bundleId, undefined);
      return `Launched ${bundleId} (PID: ${this.targetPid ?? "unknown"})`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Failed to launch ${bundleId}: ${msg}`;
    }
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
