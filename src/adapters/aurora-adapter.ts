/**
 * AuroraAdapter — wraps AuroraClient and implements PlatformAdapter.
 */

import type { PlatformAdapter } from "./platform-adapter.js";
import type { Device } from "../device-manager.js";
import { auroraClient as defaultAuroraClient, AuroraClient } from "../aurora/index.js";
import { compressScreenshot, type CompressOptions } from "../utils/image.js";

export class AuroraAdapter implements PlatformAdapter {
  readonly platform = "aurora" as const;
  private client: AuroraClient;

  constructor(client?: AuroraClient) {
    this.client = client ?? defaultAuroraClient;
  }

  /** Raw client access — needed by tools that call getAuroraClient(). */
  getClient(): AuroraClient {
    return this.client;
  }

  // ============ Device management ============

  listDevices(): Device[] {
    try {
      return this.client.listDevices();
    } catch {
      return [];
    }
  }

  selectDevice(_deviceId: string): void {
    // Aurora device selection is managed by audb config, not by the client.
    // No-op here.
  }

  getSelectedDeviceId(): string | undefined {
    try {
      return this.client.getActiveDevice();
    } catch {
      return undefined;
    }
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
    // Aurora: two taps with interval
    this.client.tap(x, y);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    this.client.tap(x, y);
  }

  async longPress(x: number, y: number, durationMs: number = 1000): Promise<void> {
    this.client.longPress(x, y, durationMs);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number,
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

  async launchApp(packageName: string): Promise<string> {
    return this.client.launchApp(packageName);
  }

  async stopApp(packageName: string): Promise<void> {
    this.client.stopApp(packageName);
  }

  async installApp(path: string): Promise<string> {
    return this.client.installApp(path);
  }

  // ============ Permissions ============

  async grantPermission(_pkg: string, _perm: string): Promise<string> {
    throw new Error("Permission management is not supported for Aurora platform");
  }

  async revokePermission(_pkg: string, _perm: string): Promise<string> {
    throw new Error("Permission management is not supported for Aurora platform");
  }

  async resetPermissions(_pkg: string): Promise<string> {
    throw new Error("Permission management is not supported for Aurora platform");
  }

  // ============ System ============

  async shell(command: string): Promise<string> {
    return this.client.shell(command);
  }

  async getLogs(options: {
    level?: string;
    tag?: string;
    lines?: number;
    package?: string;
  } = {}): Promise<string> {
    return this.client.getLogs(options);
  }

  async clearLogs(): Promise<string> {
    return this.client.clearLogs();
  }

  async getSystemInfo(): Promise<string> {
    return this.client.getSystemInfo();
  }

  // ============ App Listing ============

  async getAppList(): Promise<Array<{
    appName: string;
    packageName: string;
    versionName?: string;
    versionCode?: string;
  }>> {
    // Use the Aurora client's listPackages method
    const packages = this.client.listPackages();
    return packages.map(pkg => ({
      appName: pkg,
      packageName: pkg,
    }));
  }

  // ============ Clipboard Operations ============

  async setClipboard(text: string): Promise<void> {
    // Aurora clipboard can be set via shell
    this.client.shell(`echo '${text}' | wl-copy`);
  }

  async getClipboard(): Promise<string> {
    // Aurora clipboard can be read via shell
    return this.client.shell("wl-paste");
  }

  // ============ WebView Inspection ============

  async getWebViews(): Promise<Array<{ packageName?: string; socket?: string; [key: string]: any }>> {
    throw new Error("WebView inspection is not supported for Aurora platform");
  }
}
