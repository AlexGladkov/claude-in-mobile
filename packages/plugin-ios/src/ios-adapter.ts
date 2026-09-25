/**
 * IosAdapter -- wraps IosClient.
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
  LogsAdapter,
  UrlOpeningAdapter,
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
import { IosClient } from "./ios/client.js";
import { MobileError } from "mcp-devices/errors";
import { compressScreenshot } from "mcp-devices/utils/image";
import { validateBundleId } from "mcp-devices/utils/sanitize";
import type { CompressOptions } from "mcp-devices/utils/image";
import { PERFORMANCE } from "mcp-devices/constants/timeouts";
import { XctraceRecording } from "./ios/xctrace.js";
import type { XctraceStartOptions } from "./ios/xctrace.js";
import { captureIosHeapSnapshot } from "./ios/heap-snapshot.js";


interface ActiveIosTrace {
  recording: XctraceRecording;
  options: XctraceStartOptions;
}
export class IosAdapter
  implements CorePlatformAdapter, AppManagementAdapter, PermissionAdapter, ShellAdapter, LogsAdapter, UrlOpeningAdapter, SyncScreenshotAdapter, PerformanceTraceAdapter, HeapSnapshotAdapter
{
  readonly platform = "ios" as const;
  readonly heapSnapshotFormat = "xctrace-allocations" as const;
  private client: IosClient;
  private _selectedDeviceId: string | undefined;
  private readonly scopedClients = new Map<string, IosClient>();
  private disposePromise?: Promise<void>;
  private readonly performanceTraces = new Map<string, ActiveIosTrace>();
  private readonly heapCaptureDevices = new Set<string>();

  constructor(client?: IosClient) {
    this.client = client ?? new IosClient();
    this._selectedDeviceId = this.client.getDeviceId();
  }

  /** Raw client access -- needed by tools that call getIosClient(). */
  getClient(deviceId?: string): IosClient {
    return this.clientFor(deviceId);
  }

  /** Return a client targeting deviceId without mutating global state. */
  private clientFor(deviceId?: string): IosClient {
    if (!deviceId || deviceId === this._selectedDeviceId) return this.client;
    let scoped = this.scopedClients.get(deviceId);
    if (!scoped) {
      scoped = this.client.forDevice(deviceId);
      this.scopedClients.set(deviceId, scoped);
    }
    return scoped;
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = Promise.allSettled([
        ...[...this.performanceTraces.values()].map(({ recording }) => recording.discard()),
        this.client.cleanup(),
      ]).then(() => {
        this.performanceTraces.clear();
        this.scopedClients.clear();
      });
    }
    return this.disposePromise;
  }

  // ============ Device management ============

  listDevices(): Device[] {
    try {
      const raw = this.client.getDevices();
      return raw.map((d) => ({
        id: d.id,
        name: d.name,
        platform: "ios" as const,
        state: d.state,
        isSimulator: d.isSimulator,
      }));
    } catch (e) {
      if (e instanceof MobileError && e.code === "SIMCTL_NOT_INSTALLED") throw e;
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
    await this.clientFor(deviceId).tap(x, y, deviceId);
  }

  async doubleTap(x: number, y: number, intervalMs: number = 100, deviceId?: string): Promise<void> {
    const c = this.clientFor(deviceId);
    await c.tap(x, y, deviceId);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    await c.tap(x, y, deviceId);
  }

  async longPress(x: number, y: number, durationMs: number = 1000, deviceId?: string): Promise<void> {
    await this.clientFor(deviceId).longPress(x, y, durationMs, deviceId);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number = 300,
    deviceId?: string,
  ): Promise<void> {
    await this.clientFor(deviceId).swipe(x1, y1, x2, y2, durationMs, deviceId);
  }

  async swipeDirection(direction: "up" | "down" | "left" | "right", deviceId?: string): Promise<void> {
    await this.clientFor(deviceId).swipeDirection(direction);
  }

  async inputText(text: string, _targetPid?: number, deviceId?: string): Promise<void> {
    await this.clientFor(deviceId).inputText(text, deviceId);
  }

  async pressKey(key: string, _targetPid?: number, deviceId?: string): Promise<void> {
    await this.clientFor(deviceId).pressKey(key, deviceId);
  }

  // ============ Screenshot ============

  async screenshotAsync(
    compress: boolean = true,
    options?: CompressOptions & { monitorIndex?: number },
    deviceId?: string,
  ): Promise<{ data: string; mimeType: string }> {
    const buffer = await this.clientFor(deviceId).screenshotRawAsync(deviceId);
    if (compress) {
      return compressScreenshot(buffer, options);
    }
    return { data: buffer.toString("base64"), mimeType: "image/png" };
  }

  async getScreenshotBufferAsync(deviceId?: string): Promise<Buffer> {
    return this.clientFor(deviceId).screenshotRawAsync(deviceId);
  }

  screenshotRaw(): string {
    return this.client.screenshot();
  }

  // ============ UI ============

  getScreenPointSize(deviceId?: string): Promise<{ width: number; height: number }> {
    return this.clientFor(deviceId).getScreenPointSize(deviceId);
  }

  async getUiHierarchy(deviceId?: string): Promise<string> {
    return this.clientFor(deviceId).getUiHierarchy(deviceId);
  }

  // ============ App management (AppManagementAdapter) ============

  launchApp(bundleId: string, deviceId?: string): string {
    return this.clientFor(deviceId).launchApp(bundleId, deviceId);
  }

  stopApp(bundleId: string, deviceId?: string): void {
    this.clientFor(deviceId).stopApp(bundleId, deviceId);
  }

  installApp(path: string, deviceId?: string): string {
    return this.clientFor(deviceId).installApp(path, deviceId);
  }

  // ============ Permissions (PermissionAdapter) ============

  grantPermission(bundleId: string, service: string, deviceId?: string): string {
    this.clientFor(deviceId).grantPermission(bundleId, service, deviceId);
    return `Granted ${service} to ${bundleId}`;
  }

  revokePermission(bundleId: string, service: string, deviceId?: string): string {
    this.clientFor(deviceId).revokePermission(bundleId, service, deviceId);
    return `Revoked ${service} from ${bundleId}`;
  }

  resetPermissions(bundleId: string, deviceId?: string): string {
    this.clientFor(deviceId).resetPermissions(bundleId, deviceId);
    return `Reset permissions for ${bundleId}`;
  }

  // ============ Shell / Logs (ShellAdapter) ============

  openUrl(url: string, deviceId?: string): void {
    this.clientFor(deviceId).openUrl(url);
  }

  shell(command: string, deviceId?: string): string {
    return this.clientFor(deviceId).shell(command, deviceId);
  }

  getLogs(options: {
    level?: string;
    tag?: string;
    lines?: number;
    package?: string;
  } = {}, deviceId?: string): string {
    let predicate: string | undefined;
    if (options.package) {
      validateBundleId(options.package);
      predicate = `subsystem == "${options.package}"`;
    }
    return this.clientFor(deviceId).getLogs({
      level: options.level as "debug" | "info" | "default" | "error" | "fault" | undefined,
      lines: options.lines,
      predicate,
    }, deviceId);
  }

  clearLogs(deviceId?: string): string {
    return this.clientFor(deviceId).clearLogs(deviceId);
  }

  // ============ Performance tracing ============

  async startPerformanceTrace(options: PerformanceTraceStartOptions): Promise<PerformanceTraceHandle> {
    if (!options.bundleId) {
      throw new MobileError("bundleId is required for iOS xctrace capture.", "IOS_XCTRACE_BUNDLE_REQUIRED");
    }
    if (!Number.isInteger(options.durationMs) || options.durationMs < 1_000 || options.durationMs > PERFORMANCE.MAX_TRACE_DURATION_MS) {
      throw new MobileError(
        `durationMs must be an integer between 1000 and ${PERFORMANCE.MAX_TRACE_DURATION_MS}.`,
        "INVALID_TRACE_DURATION",
      );
    }
    const client = this.clientFor(options.deviceId);
    const deviceId = client.resolveSimulatorId(options.deviceId);
    const pid = client.getRunningAppPid(options.bundleId, options.deviceId);
    const xctraceOptions: XctraceStartOptions = {
      deviceId,
      bundleId: options.bundleId,
      pid,
      preset: options.preset,
      durationMs: options.durationMs,
      session: options.session,
    };
    const recording = await XctraceRecording.start(xctraceOptions);
    this.performanceTraces.set(recording.handle.traceId, { recording, options: xctraceOptions });
    return recording.handle;
  }

  async stopPerformanceTrace(traceId: string): Promise<PerformanceTraceCapture> {
    const active = this.performanceTraces.get(traceId);
    if (!active) {
      throw new MobileError(`Active iOS xctrace capture "${traceId}" was not found.`, "PERF_TRACE_NOT_FOUND");
    }
    try {
      const remainingMs = Math.max(0, Date.parse(active.recording.handle.deadlineAt) - Date.now());
      if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
      return await active.recording.finish(active.options);
    } finally {
      this.performanceTraces.delete(traceId);
    }
  }

  // ============ Heap snapshots (Instruments Allocations) ============

  async captureHeapSnapshot(options: HeapSnapshotOptions): Promise<HeapSnapshotCapture> {
    if (!options.bundleId) {
      throw new MobileError("bundleId is required for iOS Allocations capture.", "IOS_HEAP_BUNDLE_REQUIRED");
    }
    const client = this.clientFor(options.deviceId);
    const deviceId = client.resolveSimulatorId(options.deviceId);
    if (this.heapCaptureDevices.has(deviceId)) {
      throw new MobileError(`iOS Simulator "${deviceId}" already has an active heap capture.`, "HEAP_CAPTURE_ACTIVE");
    }
    if ([...this.performanceTraces.values()].some(({ options: trace }) => trace.deviceId === deviceId)) {
      throw new MobileError(
        `iOS Simulator "${deviceId}" is recording a performance trace. Stop it before capturing allocations.`,
        "HEAP_CAPTURE_ACTIVE",
      );
    }
    const pid = client.getRunningAppPid(options.bundleId, options.deviceId);
    this.heapCaptureDevices.add(deviceId);
    try {
      return await captureIosHeapSnapshot({
        deviceId,
        bundleId: options.bundleId,
        pid,
        outputPath: options.outputPath,
        session: options.session,
      });
    } finally {
      this.heapCaptureDevices.delete(deviceId);
    }
  }

  // ============ System info ============

  async getSystemInfo(): Promise<string> {
    return "System info is only available for Android and Aurora devices.";
  }
}
