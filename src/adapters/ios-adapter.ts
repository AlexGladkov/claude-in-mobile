/**
 * IosAdapter — wraps IosClient and implements PlatformAdapter.
 */

import type { PlatformAdapter } from "./platform-adapter.js";
import type { Device } from "../device-manager.js";
import { IosClient } from "../ios/client.js";
import { compressScreenshot, type CompressOptions } from "../utils/image.js";

export class IosAdapter implements PlatformAdapter {
  readonly platform = "ios" as const;
  private client: IosClient;
  private _selectedDeviceId: string | undefined;

  constructor(client?: IosClient) {
    this.client = client ?? new IosClient();
  }

  /** Raw client access — needed by tools that call getIosClient(). */
  getClient(): IosClient {
    return this.client;
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
    await this.client.tap(x, y);
  }

  async doubleTap(x: number, y: number, intervalMs: number = 100): Promise<void> {
    // iOS: two taps with interval
    await this.client.tap(x, y);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    await this.client.tap(x, y);
  }

  async longPress(x: number, y: number, durationMs: number = 1000): Promise<void> {
    await this.client.longPress(x, y, durationMs);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number = 300,
  ): Promise<void> {
    await this.client.swipe(x1, y1, x2, y2, durationMs);
  }

  async swipeDirection(direction: "up" | "down" | "left" | "right"): Promise<void> {
    await this.client.swipeDirection(direction);
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
    const buffer = this.client.screenshotRaw();
    if (compress) {
      return compressScreenshot(buffer, options);
    }
    return { data: buffer.toString("base64"), mimeType: "image/png" };
  }

  async getScreenshotBufferAsync(): Promise<Buffer> {
    return this.client.screenshotRaw();
  }

  screenshotRaw(): string {
    return this.client.screenshot();
  }

  // ============ UI ============

  async getUiHierarchy(): Promise<string> {
    return this.client.getUiHierarchy();
  }

  // ============ App management ============

  launchApp(bundleId: string): string {
    return this.client.launchApp(bundleId);
  }

  stopApp(bundleId: string): void {
    this.client.stopApp(bundleId);
  }

  installApp(path: string): string {
    return this.client.installApp(path);
  }

  // ============ Permissions ============

  grantPermission(bundleId: string, service: string): string {
    this.client.grantPermission(bundleId, service);
    return `Granted ${service} to ${bundleId}`;
  }

  revokePermission(bundleId: string, service: string): string {
    this.client.revokePermission(bundleId, service);
    return `Revoked ${service} from ${bundleId}`;
  }

  resetPermissions(bundleId: string): string {
    this.client.resetPermissions(bundleId);
    return `Reset permissions for ${bundleId}`;
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
      level: options.level as "debug" | "info" | "default" | "error" | "fault" | undefined,
      lines: options.lines,
      predicate: options.package ? `subsystem == "${options.package}"` : undefined,
    });
  }

  clearLogs(): string {
    return this.client.clearLogs();
  }

  async getSystemInfo(): Promise<string> {
    return "System info is only available for Android and Aurora devices.";
  }
}
