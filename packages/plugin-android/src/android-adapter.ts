/**
 * AndroidAdapter -- wraps AdbClient.
 *
 * Implements all capability interfaces:
 *   - CorePlatformAdapter
 *   - AppManagementAdapter
 *   - PermissionAdapter
 *   - ShellAdapter
 *   - SyncScreenshotAdapter
 */

import type {
  CorePlatformAdapter,
  AppManagementAdapter,
  PermissionAdapter,
  ShellAdapter,
  SyncScreenshotAdapter,
  PerformanceTraceAdapter,
  PerformanceTraceCapture,
  PerformanceTraceHandle,
  PerformanceTraceStartOptions,
  HeapSnapshotAdapter,
  HeapSnapshotCapture,
  HeapSnapshotOptions,
} from "mcp-devices/adapters/platform-adapter";
import type { Device } from "mcp-devices/device-manager";
import { AdbClient } from "./adb/client.js";
import { WebViewInspector } from "./adb/webview.js";
import { MobileError } from "mcp-devices/errors";
import { compressScreenshot } from "mcp-devices/utils/image";
import type { CompressOptions } from "mcp-devices/utils/image";
import { PERFORMANCE } from "mcp-devices/constants/timeouts";
import { randomUUID } from "crypto";
import { chmod, open, stat } from "fs/promises";
import { summarizeAndroidTrace } from "./adb/perfetto.js";
import { summarizeAndroidHeap } from "./adb/hprof.js";

interface ActiveAndroidTrace {
  handle: PerformanceTraceHandle;
  client: AdbClient;
  deviceKey: string;
  packageName?: string;
}

export class AndroidAdapter
  implements CorePlatformAdapter, AppManagementAdapter, PermissionAdapter, ShellAdapter, SyncScreenshotAdapter, PerformanceTraceAdapter, HeapSnapshotAdapter
{
  readonly platform = "android" as const;
  readonly heapSnapshotFormat = "android-hprof" as const;
  private client: AdbClient;
  private _selectedDeviceId: string | undefined;
  private readonly performanceTraces = new Map<string, ActiveAndroidTrace>();

  constructor(client?: AdbClient) {
    this.client = client ?? new AdbClient();
    this._selectedDeviceId = this.client.getDeviceId();
  }

  /** Raw client access -- needed by tools that call getAndroidClient(). */
  getClient(deviceId?: string): AdbClient {
    return this.clientFor(deviceId);
  }

  private _webViewInspector?: WebViewInspector;
  getWebViewInspector(): WebViewInspector {
    if (!this._webViewInspector) this._webViewInspector = new WebViewInspector(this.client);
    return this._webViewInspector;
  }
  dispose(): void {
    this._webViewInspector?.cleanup();
    this._webViewInspector = undefined;
    for (const trace of this.performanceTraces.values()) {
      trace.client.discardPerfettoTrace(trace.handle.traceId);
    }
    this.performanceTraces.clear();
  }


  /** Return a client targeting deviceId without mutating global state. */
  private clientFor(deviceId?: string): AdbClient {
    if (!deviceId || deviceId === this._selectedDeviceId) return this.client;
    return new AdbClient(deviceId);
  }

  // ============ Device management ============

  listDevices(): Device[] {
    try {
      const raw = this.client.getDevices();
      return raw.map((d) => ({
        id: d.id,
        name: d.model ?? d.id,
        platform: "android" as const,
        state: d.state,
        isSimulator: d.id.startsWith("emulator"),
      }));
    } catch (e) {
      // Propagate when the cause is structural (adb not installed) — silently swallowing
      // sends users hunting for cable/auth problems when the real fix is `ADB_PATH=...`.
      // Transient failures (offline daemon, permission denied) still return [] so callers
      // can degrade gracefully.
      if (e instanceof MobileError && e.code === "ADB_NOT_INSTALLED") throw e;
      return [];
    }
  }

  selectDevice(deviceId: string): void {
    this._selectedDeviceId = deviceId;
    this.client.setDevice(deviceId);
  }

  getSelectedDeviceId(): string | undefined {
    return this._selectedDeviceId;
  }

  autoDetectDevice(): Device | undefined {
    const devices = this.listDevices();
    return devices.find(
      (d) => d.state === "device" || d.state === "booted" || d.state === "connected",
    );
  }

  // ============ Core actions ============

  async tap(x: number, y: number, _targetPid?: number, deviceId?: string): Promise<void> {
    this.clientFor(deviceId).tap(x, y);
  }

  async doubleTap(x: number, y: number, intervalMs: number = 100, deviceId?: string): Promise<void> {
    this.clientFor(deviceId).doubleTap(x, y, intervalMs);
  }

  async longPress(x: number, y: number, durationMs: number = 1000, deviceId?: string): Promise<void> {
    this.clientFor(deviceId).longPress(x, y, durationMs);
  }

  selectAll(): void {
    this.client.selectAll();
  }

  copyToClipboard(): void {
    this.client.copyToClipboard();
  }

  pasteFromClipboard(): void {
    this.client.pasteFromClipboard();
  }

  getClipboardText(): string {
    return this.client.getClipboardText();
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number = 300,
    deviceId?: string,
  ): Promise<void> {
    this.clientFor(deviceId).swipe(x1, y1, x2, y2, durationMs);
  }

  async swipeDirection(direction: "up" | "down" | "left" | "right", deviceId?: string): Promise<void> {
    this.clientFor(deviceId).swipeDirection(direction);
  }

  async inputText(text: string, _targetPid?: number, deviceId?: string): Promise<void> {
    this.clientFor(deviceId).inputText(text);
  }

  async pressKey(key: string, _targetPid?: number, deviceId?: string): Promise<void> {
    this.clientFor(deviceId).pressKey(key);
  }

  // ============ Screenshot ============

  async screenshotAsync(
    compress: boolean = true,
    options?: CompressOptions & { monitorIndex?: number },
    deviceId?: string,
  ): Promise<{ data: string; mimeType: string }> {
    const buffer = await this.clientFor(deviceId).screenshotRawAsync();
    if (compress) {
      return compressScreenshot(buffer, options);
    }
    return { data: buffer.toString("base64"), mimeType: "image/png" };
  }

  async getScreenshotBufferAsync(deviceId?: string): Promise<Buffer> {
    return this.clientFor(deviceId).screenshotRawAsync();
  }

  screenshotRaw(): string {
    return this.client.screenshot();
  }

  // ============ UI ============

  async getUiHierarchy(deviceId?: string, turbo?: boolean): Promise<string> {
    return this.clientFor(deviceId).getUiHierarchyAsync(turbo);
  }

  // ============ App management (AppManagementAdapter) ============

  launchApp(packageName: string, deviceId?: string): string {
    return this.clientFor(deviceId).launchApp(packageName);
  }

  stopApp(packageName: string, deviceId?: string): void {
    this.clientFor(deviceId).stopApp(packageName);
  }

  installApp(path: string, deviceId?: string): string {
    return this.clientFor(deviceId).installApk(path);
  }

  // ============ Permissions (PermissionAdapter) ============

  grantPermission(packageName: string, permission: string, deviceId?: string): string {
    this.clientFor(deviceId).grantPermission(packageName, permission);
    return `Granted ${permission} to ${packageName}`;
  }

  revokePermission(packageName: string, permission: string, deviceId?: string): string {
    this.clientFor(deviceId).revokePermission(packageName, permission);
    return `Revoked ${permission} from ${packageName}`;
  }

  resetPermissions(packageName: string, deviceId?: string): string {
    this.clientFor(deviceId).resetPermissions(packageName);
    return `Reset permissions for ${packageName}`;
  }

  // ============ Shell / Logs (ShellAdapter) ============

  shell(command: string, deviceId?: string): string {
    return this.clientFor(deviceId).shell(command);
  }

  getLogs(options: {
    level?: string;
    tag?: string;
    lines?: number;
    package?: string;
  } = {}, deviceId?: string): string {
    return this.clientFor(deviceId).getLogs({
      level: options.level as "V" | "D" | "I" | "W" | "E" | "F" | undefined,
      tag: options.tag,
      lines: options.lines,
      package: options.package,
    });
  }

  clearLogs(deviceId?: string): string {
    this.clientFor(deviceId).clearLogs();
    return "Logcat buffer cleared";
  }

  // ============ Performance traces (Perfetto) ============

  async startPerformanceTrace(options: PerformanceTraceStartOptions): Promise<PerformanceTraceHandle> {
    if (!Number.isInteger(options.durationMs) || options.durationMs < 1000 || options.durationMs > PERFORMANCE.MAX_TRACE_DURATION_MS) {
      throw new Error(
        `Android trace duration must be an integer from 1000 to ${PERFORMANCE.MAX_TRACE_DURATION_MS}ms.`,
      );
    }
    const deviceKey = options.deviceId ?? this._selectedDeviceId ?? "default";
    if ([...this.performanceTraces.values()].some((trace) => trace.deviceKey === deviceKey)) {
      throw new Error(`Android device "${deviceKey}" already has an active performance trace.`);
    }

    const client = this.clientFor(options.deviceId);
    const traceId = randomUUID();
    const durationMs = Math.ceil(options.durationMs / 1000) * 1000;
    const startedAtMs = Date.now();
    await client.startPerfettoTrace(traceId, options.preset, durationMs, options.packageName);
    const handle: PerformanceTraceHandle = {
      traceId,
      platform: "android",
      preset: options.preset,
      startedAt: new Date(startedAtMs).toISOString(),
      deadlineAt: new Date(startedAtMs + durationMs).toISOString(),
    };
    this.performanceTraces.set(traceId, {
      handle,
      client,
      deviceKey,
      packageName: options.packageName,
    });
    return handle;
  }

  async stopPerformanceTrace(traceId: string): Promise<PerformanceTraceCapture> {
    const active = this.performanceTraces.get(traceId);
    if (!active) {
      throw new Error(`Android performance trace "${traceId}" is not active.`);
    }
    try {
      const remainingMs = Date.parse(active.handle.deadlineAt) - Date.now();
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }
      // Perfetto finalizes its output asynchronously after the configured window.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { data, gfxOutput } = await active.client.finishPerfettoTrace(
        traceId,
        active.packageName,
      );
      const endedAtMs = Date.now();
      return {
        ...active.handle,
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: Math.max(0, endedAtMs - Date.parse(active.handle.startedAt)),
        format: "perfetto-proto",
        mimeType: "application/vnd.google.perfetto.trace",
        producer: "Android Perfetto",
        packageName: active.packageName,
        summary: summarizeAndroidTrace(gfxOutput),
        data,
      };
    } finally {
      this.performanceTraces.delete(traceId);
    }
  }

  // ============ Heap snapshots (HPROF) ============

  async captureHeapSnapshot(options: HeapSnapshotOptions): Promise<HeapSnapshotCapture> {
    if (!options.packageName) {
      throw new MobileError("packageName is required for Android HPROF capture.", "ANDROID_HPROF_PACKAGE_REQUIRED");
    }
    const client = this.clientFor(options.deviceId);
    const meminfo = await client.captureHeapSnapshot(options.packageName, options.outputPath);
    await chmod(options.outputPath, 0o600);
    const details = await stat(options.outputPath);
    const file = await open(options.outputPath, "r");
    try {
      const header = Buffer.alloc(20);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (!header.subarray(0, bytesRead).toString("ascii").startsWith("JAVA PROFILE 1.0.")) {
        throw new MobileError("Android dumpheap returned an invalid HPROF artifact.", "ANDROID_HPROF_INVALID");
      }
    } finally {
      await file.close();
    }
    return {
      platform: "android",
      capturedAt: new Date().toISOString(),
      format: this.heapSnapshotFormat,
      mimeType: "application/octet-stream",
      producer: "Android Runtime am dumpheap",
      packageName: options.packageName,
      session: options.session,
      summary: summarizeAndroidHeap(details.size, meminfo),
    };
  }

  // ============ System info ============

  async getSystemInfo(deviceId?: string): Promise<string> {
    const c = this.clientFor(deviceId);
    const battery = c.getBatteryInfo();
    const memory = c.getMemoryInfo();
    return `=== Battery ===\n${battery}\n\n=== Memory ===\n${memory}`;
  }
}
