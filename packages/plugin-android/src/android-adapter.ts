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
} from "claude-in-mobile/adapters/platform-adapter";
import type { Device } from "claude-in-mobile/device-manager";
import { AdbClient } from "./adb/client.js";
import { WebViewInspector } from "./adb/webview.js";
import { MobileError } from "claude-in-mobile/errors";
import { compressScreenshot, type CompressOptions } from "claude-in-mobile/utils/image";

export class AndroidAdapter
  implements CorePlatformAdapter, AppManagementAdapter, PermissionAdapter, ShellAdapter, SyncScreenshotAdapter
{
  readonly platform = "android" as const;
  private client: AdbClient;
  private _selectedDeviceId: string | undefined;

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

  // ============ System info ============

  async getSystemInfo(deviceId?: string): Promise<string> {
    const c = this.clientFor(deviceId);
    const battery = c.getBatteryInfo();
    const memory = c.getMemoryInfo();
    return `=== Battery ===\n${battery}\n\n=== Memory ===\n${memory}`;
  }
}
