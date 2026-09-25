/**
 * Desktop Client - communicates with Kotlin companion app via JSON-RPC
 */

import { spawn, execFileSync } from "child_process";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { StringDecoder } from "string_decoder";
import { z } from "zod";

import { GradleLauncher } from "./gradle.js";
import { findCompanionAppPath } from "./permission-allowlist.js";
import { LogRing } from "./log-ring.js";
import { normalizeLaunchOptions } from "./launch-options.js";
import { DESKTOP } from "mcp-devices/constants/timeouts";
import { sanitizeErrorMessage } from "mcp-devices/utils/sanitize";
import {
  AttachLauncher,
  BundleAppLauncher,
  GradleAppLauncher,
  NoOpLauncher,
} from "./launchers.js";
import type { AppLaunchStrategy } from "./launchers.js";

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
  LaunchOptions,
  RawLaunchOptions,
  ScreenshotOptions,
  ScreenshotResult,
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
  TapByTextResult,
} from "./types.js";

const MAX_RESTARTS = 3;
const MAX_RPC_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const safeRpcTextSchema = z.string().max(64 * 1024);
const finiteNumberSchema = z.number().finite();
const boundsSchema = z.object({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  width: finiteNumberSchema.nonnegative(),
  height: finiteNumberSchema.nonnegative(),
}).strict();
const desktopWindowSchema = z.object({
  id: z.string().min(1).max(4096),
  title: safeRpcTextSchema,
  bounds: boundsSchema,
  focused: z.boolean(),
  minimized: z.boolean(),
  fullscreen: z.boolean(),
  processId: z.number().int().safe().nonnegative().optional(),
  ownerName: safeRpcTextSchema.optional(),
}).strict();
const desktopUiElementSchema: z.ZodType<DesktopUiElement> = z.lazy(() => z.object({
  index: z.number().int().safe().nonnegative(),
  id: z.string().max(4096).optional(),
  text: safeRpcTextSchema.optional(),
  contentDescription: safeRpcTextSchema.optional(),
  className: z.string().min(1).max(4096),
  role: z.string().max(4096).optional(),
  password: z.boolean().optional(),
  bounds: boundsSchema,
  clickable: z.boolean(),
  enabled: z.boolean(),
  focused: z.boolean(),
  focusable: z.boolean(),
  children: z.array(desktopUiElementSchema).max(1000),
  centerX: finiteNumberSchema,
  centerY: finiteNumberSchema,
}).strict());
const screenshotResultSchema = z.object({
  base64: z.string().max(MAX_RPC_MESSAGE_BYTES).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  width: z.number().int().positive().max(32_768),
  height: z.number().int().positive().max(32_768),
  scaleFactor: finiteNumberSchema.positive().max(16),
  mimeType: z.literal("image/jpeg"),
}).strict().refine(
  (value) => value.width * value.height <= 40_000_000,
  "desktop screenshot exceeds pixel limit",
);
const tapByTextResultSchema = z.object({
  success: z.boolean(),
  elementRole: z.string().max(4096).optional(),
  error: safeRpcTextSchema.optional(),
}).strict();
const uiHierarchySchema = z.object({
  windows: z.array(desktopWindowSchema).max(1000),
  elements: z.array(desktopUiElementSchema).max(10_000),
  scaleFactor: finiteNumberSchema.positive().max(16),
}).strict();
const windowInfoSchema = z.object({
  windows: z.array(desktopWindowSchema).max(1000),
  activeWindowId: z.string().max(4096).nullable(),
}).strict();
const clipboardResultSchema = z.object({
  text: z.string().max(1024 * 1024),
}).strict();
const permissionStatusSchema = z.object({
  granted: z.boolean(),
  instructions: z.array(safeRpcTextSchema).max(100).optional(),
}).strict();
const performanceMetricsSchema = z.object({
  fps: finiteNumberSchema.nonnegative().optional(),
  memoryUsageMb: finiteNumberSchema.nonnegative(),
  cpuPercent: finiteNumberSchema.nonnegative().optional(),
}).strict();
const monitorInfoSchema = z.object({
  index: z.number().int().safe().nonnegative(),
  name: z.string().max(4096),
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  width: finiteNumberSchema.positive(),
  height: finiteNumberSchema.positive(),
  isPrimary: z.boolean(),
}).strict();
const monitorsResultSchema = z.object({
  monitors: z.array(monitorInfoSchema).max(100),
}).strict();
const rpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.number().int().safe(),
  result: z.unknown().optional(),
  error: z.object({
    code: z.number().int().safe(),
  }).passthrough().optional(),
}).strict();

interface RpcResponseEnvelope {
  id: number;
  result?: unknown;
  errorCode?: number;
}

function parseRpcResponse(value: unknown): RpcResponseEnvelope | null {
  const parsed = rpcResponseSchema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.error
    ? { id: parsed.data.id, errorCode: parsed.data.error.code }
    : { id: parsed.data.id, result: parsed.data.result };
}
function exceedsJsonDepth(text: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > maxDepth) return true;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) return true;
    }
  }
  return depth !== 0 || inString;
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
  private readonly logRing = new LogRing();
  private state: DesktopState = {
    status: "stopped",
    crashCount: 0,
    targetPid: null,
  };
  private lastLaunchOptions: RawLaunchOptions | null = null;
  private stdoutBuffer = "";
  private stdoutDecoder: StringDecoder | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private lifecycleEpoch = 0;
  private restartTimer?: NodeJS.Timeout;
  private readonly handledFailures = new WeakSet<ChildProcess>();
  private teardownPending = false;

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
    return this.state.status === "running"
      && this.process !== null
      && this.process.exitCode === null
      && this.process.signalCode === null;
  }

  /**
   * Launch desktop automation. Accepts the flat RawLaunchOptions (backward-compatible)
   * and normalizes internally to the discriminated-union LaunchOptions.
   */
  launch(options: RawLaunchOptions): Promise<void> {
    if (
      this.state.status === "starting"
      || this.state.status === "running"
      || this.teardownPending
      || (this.process !== null
        && this.process.exitCode === null
        && this.process.signalCode === null)
    ) {
      return Promise.reject(new Error("Desktop companion is already running. Stop it first."));
    }

    const epoch = ++this.lifecycleEpoch;
    this.state = {
      status: "starting",
      crashCount: this.state.crashCount,
      targetPid: null,
    };
    return this.enqueueLifecycle(() => this.runLaunch(options, epoch));
  }

  private async runLaunch(options: RawLaunchOptions, epoch: number): Promise<void> {
    let child: ChildProcess | undefined;

    try {
      if (epoch !== this.lifecycleEpoch) throw new Error("Desktop launch cancelled");
      const normalized = normalizeLaunchOptions(options);
      this.lastLaunchOptions = options;
      this.state.projectPath = normalized.mode === "gradle" ? normalized.projectPath : undefined;
      const companionPath = findCompanionAppPath();
      this.addLog("stdout", `Starting companion app: ${companionPath}`);
      child = spawn(companionPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          JAVA_HOME: process.env.JAVA_HOME || (() => {
            if (process.platform !== "darwin") return "";
            try {
              return execFileSync("/usr/libexec/java_home", ["-v", "21"], {
                encoding: "utf-8",
                timeout: 3000,
                maxBuffer: 64 * 1024,
              }).trim();
            } catch {
              try {
                return execFileSync("/usr/libexec/java_home", [], {
                  encoding: "utf-8",
                  timeout: 3000,
                  maxBuffer: 64 * 1024,
                }).trim();
              } catch { return ""; }
            }
          })(),
        },
      });
      this.process = child;
      this.state.pid = child.pid;

      if (child.stdout) {
        const decoder = new StringDecoder("utf8");
        this.stdoutDecoder = decoder;
        child.stdout.on("data", (data: Buffer) => {
          if (this.process !== child || epoch !== this.lifecycleEpoch) return;
          const chunk = decoder.write(data);
          if (this.stdoutBuffer.length + chunk.length > MAX_RPC_MESSAGE_BYTES) {
            this.handleProcessFailure(
              child,
              epoch,
              new Error("Desktop companion response exceeded the size limit"),
            );
            return;
          }
          this.stdoutBuffer += chunk;
          let newline: number;
          while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
            const line = this.stdoutBuffer.slice(0, newline);
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            this.handleLine(line);
          }
        });
      }
      child.stderr?.on("data", (data: Buffer) => {
        if (this.process !== child || epoch !== this.lifecycleEpoch) return;
        const message = data.toString();
        this.addLog("stderr", message);
        if (message.includes("Desktop companion ready") || message.includes("JsonRpcServer started")) {
          this.state.status = "running";
          this.emit("ready");
        }
      });
      child.stdin?.on("error", (error) => {
        if (this.process === child) this.handleStreamFailure(error);
      });
      child.on("exit", (code, signal) => this.handleExit(child!, epoch, code, signal));
      child.on("error", (error) => this.handleProcessFailure(child!, epoch, error));

      await this.waitForReady(child, epoch, 10_000);
      if (epoch !== this.lifecycleEpoch || this.process !== child) {
        throw new Error("Desktop launch cancelled");
      }

      const strategy = this.selectStrategy(normalized);
      this.activeStrategy = strategy;
      const targetPid = await strategy.launch();
      if (epoch !== this.lifecycleEpoch || this.process !== child) {
        throw new Error("Desktop launch cancelled");
      }
      this.state.targetPid = targetPid;
      this.targetPid = targetPid ?? undefined;
    } catch (error) {
      let rollbackError: unknown;
      try {
        await this.teardown(child, true);
      } catch (cleanupError) {
        rollbackError = cleanupError;
      }
      if (epoch === this.lifecycleEpoch) {
        const message = error instanceof Error ? error.message : String(error);
        const rollbackMessage = rollbackError instanceof Error
          ? `; rollback failed: ${rollbackError.message}`
          : "";
        this.state.status = rollbackError ? "crashed" : "stopped";
        this.state.lastError = `${message}${rollbackMessage}`;
        this.state.pid = undefined;
        this.state.targetPid = null;
        this.targetPid = undefined;
      }
      if (rollbackError) {
        const message = error instanceof Error ? error.message : String(error);
        const cleanupMessage = rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
        throw new Error(`${message}; rollback failed: ${cleanupMessage}`);
      }
      throw error;
    }
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private selectStrategy(opts: LaunchOptions): AppLaunchStrategy {
    switch (opts.mode) {
      case "gradle":
        return new GradleAppLauncher(opts, this.gradleLauncher, this.addLog.bind(this));
      case "bundle":
        return new BundleAppLauncher(opts, this.gradleLauncher, this.addLog.bind(this));
      case "attach":
        return new AttachLauncher(opts, this.addLog.bind(this));
      case "companion-only":
        return new NoOpLauncher();
    }
  }

  private async stopActiveStrategy(): Promise<void> {
    const strategy = this.activeStrategy;
    this.activeStrategy = null;
    if (strategy) await strategy.stop();
  }

  private async teardown(child: ChildProcess | undefined, terminateChild: boolean): Promise<void> {
    const operations: Promise<void>[] = [this.stopActiveStrategy()];
    if (child) operations.push(this.detachProcess(child, terminateChild));
    const results = await Promise.allSettled(operations);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new Error(
        `Desktop teardown failed: ${errors.map((error) =>
          error instanceof Error ? error.message : String(error)
        ).join("; ")}`,
      );
    }
  }

  getTargetPid(): number | null {
    return this.state.targetPid;
  }

  /**
   * Wait for the companion app to be ready
   */
  private waitForReady(
    child: ChildProcess,
    epoch: number,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.removeListener("ready", onReady);
        this.removeListener("lifecycle-cancel", onCancel);
        child.removeListener("exit", onExit);
      };
      const onReady = () => {
        if (this.process !== child || epoch !== this.lifecycleEpoch) return;
        cleanup();
        resolve();
      };
      const onExit = () => {
        cleanup();
        reject(new Error("Desktop app exited before becoming ready"));
      };
      const onCancel = () => {
        cleanup();
        reject(new Error("Desktop launch cancelled"));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Desktop companion did not report ready before timeout"));
      }, timeoutMs);

      this.once("ready", onReady);
      this.once("lifecycle-cancel", onCancel);
      child.once("exit", onExit);
    });
  }

  /**
   * Stop desktop app
   */
  stop(): Promise<void> {
    ++this.lifecycleEpoch;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.lastLaunchOptions = null;
    this.emit("lifecycle-cancel");
    return this.enqueueLifecycle(() => this.runStop());
  }

  private async runStop(): Promise<void> {
    const child = this.process;
    let cleanupError: unknown;
    try {
      await this.teardown(child ?? undefined, true);
    } catch (error) {
      cleanupError = error;
    }
    this.rejectPending(new Error("Desktop app stopped"));
    this.targetPid = undefined;
    this.state = {
      status: "stopped",
      crashCount: 0,
      targetPid: null,
    };
    if (cleanupError) throw cleanupError;
  }

  /**
   * Handle incoming line from stdout
   */
  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("{")) {
      try {
        if (exceedsJsonDepth(trimmed, 64)) return;
        const response = parseRpcResponse(JSON.parse(trimmed));
        if (response) {
          this.handleResponse(response);
          return;
        }
      } catch {
        // Non-JSON output is retained only as a bounded log entry.
      }
    }

    // Regular log output
    this.addLog("stdout", trimmed);
  }

  /**
   * Handle JSON-RPC response
   */
  private handleResponse(response: RpcResponseEnvelope): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    this.pendingRequests.delete(response.id);
    clearTimeout(pending.timeout);

    if (response.errorCode !== undefined) {
      pending.reject(new Error(`Desktop companion request failed (code: ${response.errorCode})`));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleExit(
    child: ChildProcess,
    epoch: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.process !== child || epoch !== this.lifecycleEpoch) return;
    this.emit("lifecycle-cancel");
    if (code !== 0 && this.state.status !== "stopped") {
      this.addLog("crash", `Process exited with code ${code}, signal ${signal}`);
      this.handleProcessFailure(child, epoch, new Error(`Exit code: ${code}`));
      return;
    }
    this.teardownPending = true;
    this.rejectPending(new Error("Desktop app exited"));
    void this.enqueueLifecycle(async () => {
      let cleanupError: unknown;
      try {
        await this.teardown(child, false);
      } catch (error) {
        cleanupError = error;
      }
      if (epoch === this.lifecycleEpoch) {
        this.targetPid = undefined;
        this.state.status = cleanupError ? "crashed" : "stopped";
        this.state.pid = undefined;
        this.state.targetPid = null;
        if (cleanupError) {
          this.state.lastError = cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        }
      }
      this.teardownPending = false;
      if (cleanupError) this.emit("crash", cleanupError);
    });
  }

  private handleStreamFailure(error: Error): void {
    this.rejectPending(new Error(`Desktop companion stream failed: ${error.message}`));
    const child = this.process;
    if (child) this.handleProcessFailure(child, this.lifecycleEpoch, error);
  }

  private handleProcessFailure(child: ChildProcess, epoch: number, error: Error): void {
    if (
      this.process !== child
      || epoch !== this.lifecycleEpoch
      || this.handledFailures.has(child)
    ) return;
    this.handledFailures.add(child);
    this.emit("lifecycle-cancel");
    this.addLog("crash", `Process error: ${error.message}`);
    this.state.status = "crashed";
    this.state.crashCount++;
    this.state.lastError = error.message;
    this.rejectPending(new Error("Desktop app crashed"));
    this.teardownPending = true;
    const options = this.lastLaunchOptions;
    const crashCount = this.state.crashCount;
    void this.enqueueLifecycle(async () => {
      let cleanupError: unknown;
      try {
        await this.teardown(child, true);
      } catch (teardownError) {
        cleanupError = teardownError;
      }
      if (epoch !== this.lifecycleEpoch) {
        this.teardownPending = false;
        return;
      }
      this.targetPid = undefined;
      this.state.pid = undefined;
      this.state.targetPid = null;
      this.teardownPending = false;
      if (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
        this.state.lastError = `${error.message}; ${cleanupMessage}`;
        this.emit("crash", cleanupError);
        return;
      }

      if (crashCount <= MAX_RESTARTS && options) {
        console.error(
          `Desktop app crashed, restarting (${crashCount}/${MAX_RESTARTS})...`,
        );
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          if (epoch !== this.lifecycleEpoch || this.lastLaunchOptions !== options) return;
          this.launch(options).catch((restartError: unknown) => {
            console.error(`Failed to restart: ${sanitizeErrorMessage(restartError)}`);
          });
        }, 1_000);
      } else {
        this.emit("crash", error);
      }
    });
  }

  private async detachProcess(child: ChildProcess, terminate: boolean): Promise<void> {
    if (this.process !== child) return;
    if (this.stdoutDecoder) {
      this.stdoutDecoder.end();
      this.stdoutDecoder = null;
    }
    this.stdoutBuffer = "";
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    child.stdin?.removeAllListeners();
    child.removeAllListeners();
    this.process = null;
    if (
      terminate
      && child.exitCode === null
      && child.signalCode === null
    ) {
      await this.gradleLauncher.stop(child);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Send JSON-RPC request
   */
  private async sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const child = this.process;
    const stdin = child?.stdin;
    if (!this.isRunning() || !child || !stdin) {
      throw new Error("Desktop app is not running");
    }
    if (this.pendingRequests.size >= MAX_PENDING_REQUESTS) {
      throw new Error("Desktop companion has too many pending requests");
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    const payload = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(payload) > MAX_RPC_MESSAGE_BYTES) {
      throw new Error("Desktop request exceeded the size limit");
    }

    return new Promise<unknown>((resolve, reject) => {
      const fail = (error: Error) => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        clearTimeout(pending.timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, DESKTOP.RPC_TIMEOUT_MS);
      this.pendingRequests.set(id, {
        resolve,
        reject,
        timeout,
      });

      try {
        stdin.write(payload, (error) => {
          if (error) fail(new Error(`Desktop request write failed: ${error.message}`));
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
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
    const result = screenshotResultSchema.parse(
      await this.sendRequest("screenshot", options ? { ...options } : undefined),
    );
    return Buffer.from(result.base64, "base64");
  }

  /**
   * Take screenshot and return base64
   */
  async screenshot(options?: ScreenshotOptions): Promise<string> {
    const result = screenshotResultSchema.parse(
      await this.sendRequest("screenshot", options ? { ...options } : undefined),
    );
    return result.base64;
  }

  /**
   * Get screenshot with metadata
   */
  async screenshotWithMeta(options?: ScreenshotOptions): Promise<ScreenshotResult> {
    return screenshotResultSchema.parse(
      await this.sendRequest("screenshot", options ? { ...options } : undefined),
    );
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
    return tapByTextResultSchema.parse(
      await this.sendRequest("tap_by_text", { text, pid: resolvedPid, exactMatch }),
    );
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
    return uiHierarchySchema.parse(
      await this.sendRequest("get_ui_hierarchy", { windowId }),
    );
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
    return windowInfoSchema.parse(await this.sendRequest("get_window_info"));
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
    const result = clipboardResultSchema.parse(await this.sendRequest("get_clipboard"));
    return result.text;
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
    return permissionStatusSchema.parse(await this.sendRequest("check_permissions"));
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
    return performanceMetricsSchema.parse(
      await this.sendRequest("get_performance_metrics"),
    );
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
    const result = monitorsResultSchema.parse(await this.sendRequest("get_monitors"));
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
