/**
 * AndroidAdapter — wraps AdbClient and implements PlatformAdapter.
 */

import type { PlatformAdapter } from "./platform-adapter.js";
import type { Device } from "../device-manager.js";
import { AdbClient } from "../adb/client.js";
import { compressScreenshot, type CompressOptions } from "../utils/image.js";

export class AndroidAdapter implements PlatformAdapter {
  readonly platform = "android" as const;
  private client: AdbClient;
  private _selectedDeviceId: string | undefined;

  constructor(client?: AdbClient) {
    this.client = client ?? new AdbClient();
  }

  /** Raw client access — needed by tools that call getAndroidClient(). */
  getClient(): AdbClient {
    return this.client;
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
    } catch {
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

  async tap(x: number, y: number): Promise<void> {
    this.client.tap(x, y);
  }

  async doubleTap(x: number, y: number, intervalMs: number = 100): Promise<void> {
    this.client.doubleTap(x, y, intervalMs);
  }

  async longPress(x: number, y: number, durationMs: number = 1000): Promise<void> {
    this.client.longPress(x, y, durationMs);
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
  ): Promise<void> {
    this.client.swipe(x1, y1, x2, y2, durationMs);
  }

  async swipeDirection(direction: "up" | "down" | "left" | "right"): Promise<void> {
    this.client.swipeDirection(direction);
  }

  async inputText(text: string): Promise<void> {
    this.client.inputText(text);
  }

  async pressKey(key: string): Promise<void> {
    this.client.pressKey(key);
  }

  // ============ Screenshot ============

  async screenshotAsync(
    compress: boolean = true,
    options?: CompressOptions & { monitorIndex?: number },
  ): Promise<{ data: string; mimeType: string }> {
    const buffer = await this.client.screenshotRawAsync();
    if (compress) {
      return compressScreenshot(buffer, options);
    }
    return { data: buffer.toString("base64"), mimeType: "image/png" };
  }

  async getScreenshotBufferAsync(): Promise<Buffer> {
    return this.client.screenshotRawAsync();
  }

  screenshotRaw(): string {
    return this.client.screenshot();
  }

  // ============ UI ============

  async getUiHierarchy(): Promise<string> {
    return this.client.getUiHierarchyAsync();
  }

  // ============ App management ============

  launchApp(packageName: string): string {
    return this.client.launchApp(packageName);
  }

  stopApp(packageName: string): void {
    this.client.stopApp(packageName);
  }

  installApp(path: string): string {
    return this.client.installApk(path);
  }

  // ============ Permissions ============

  grantPermission(packageName: string, permission: string): string {
    this.client.grantPermission(packageName, permission);
    return `Granted ${permission} to ${packageName}`;
  }

  revokePermission(packageName: string, permission: string): string {
    this.client.revokePermission(packageName, permission);
    return `Revoked ${permission} from ${packageName}`;
  }

  resetPermissions(packageName: string): string {
    this.client.resetPermissions(packageName);
    return `Reset permissions for ${packageName}`;
  }

  // ============ System ============

  shell(command: string): string {
    return this.client.shell(command);
  }

  getLogs(options: {
    level?: string;
    tag?: string;
    lines?: number;
    package?: string;
  } = {}): string {
    return this.client.getLogs({
      level: options.level as "V" | "D" | "I" | "W" | "E" | "F" | undefined,
      tag: options.tag,
      lines: options.lines,
      package: options.package,
    });
  }

  clearLogs(): string {
    this.client.clearLogs();
    return "Logcat buffer cleared";
  }

  async getSystemInfo(): Promise<string> {
    const battery = this.client.getBatteryInfo();
    const memory = this.client.getMemoryInfo();
    return `=== Battery ===\n${battery}\n\n=== Memory ===\n${memory}`;
  }
}
