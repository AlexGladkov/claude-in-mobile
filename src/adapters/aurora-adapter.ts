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

  launchApp(packageName: string): string {
    return this.client.launchApp(packageName);
  }

  stopApp(packageName: string): void {
    this.client.stopApp(packageName);
  }

  installApp(path: string): string {
    return this.client.installApp(path);
  }

  // ============ Permissions ============

  grantPermission(_pkg: string, _perm: string): string {
    throw new Error("Permission management is not supported for Aurora platform");
  }

  revokePermission(_pkg: string, _perm: string): string {
    throw new Error("Permission management is not supported for Aurora platform");
  }

  resetPermissions(_pkg: string): string {
    throw new Error("Permission management is not supported for Aurora platform");
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
    return this.client.getLogs(options);
  }

  clearLogs(): string {
    return this.client.clearLogs();
  }

  async getSystemInfo(): Promise<string> {
    return this.client.getSystemInfo();
  }
}
