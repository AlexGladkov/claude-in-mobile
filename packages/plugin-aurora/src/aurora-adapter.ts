/**
 * AuroraAdapter -- wraps AuroraClient.
 *
 * Implements core interaction, app lifecycle and inventory, shell/logs,
 * file transfer, and synchronous screenshots.
 *
 * Does NOT implement PermissionAdapter -- Aurora OS does not support
 * runtime permission management.
 */

import type {
  AppInventoryAdapter,
  AppManagementAdapter,
  CorePlatformAdapter,
  FileTransferAdapter,
  ShellAdapter,
  SyncScreenshotAdapter,
} from "mcp-devices/adapters/platform-adapter";
import type { Device } from "mcp-devices/device-manager";
import { auroraClient as defaultAuroraClient, AuroraClient } from "./client.js";
import { compressScreenshot } from "mcp-devices/utils/image";
import type { CompressOptions } from "mcp-devices/utils/image";

export class AuroraAdapter
  implements
    CorePlatformAdapter,
    AppManagementAdapter,
    AppInventoryAdapter,
    ShellAdapter,
    FileTransferAdapter,
    SyncScreenshotAdapter
{
  readonly platform = "aurora" as const;
  private client: AuroraClient;

  constructor(client?: AuroraClient) {
    this.client = client ?? defaultAuroraClient;
  }

  /** Raw client access -- needed by tools that call getAuroraClient(). */
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

  selectDevice(deviceId: string): void {
    this.client.selectDevice(deviceId);
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

  // ============ App management (AppManagementAdapter) ============

  launchApp(packageName: string): string {
    return this.client.launchApp(packageName);
  }

  stopApp(packageName: string): void {
    this.client.stopApp(packageName);
  }

  installApp(path: string): string {
    return this.client.installApp(path);
  }

  // ============ App inventory (AppInventoryAdapter) ============

  listApps(): string[] {
    return this.client.listPackages();
  }

  uninstallApp(packageName: string): string {
    return this.client.uninstallApp(packageName);
  }

  // ============ Shell / Logs (ShellAdapter) ============

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

  // ============ File transfer (FileTransferAdapter) ============

  pushFile(localPath: string, remotePath: string): string {
    return this.client.pushFile(localPath, remotePath);
  }

  pullFile(remotePath: string, localPath?: string): string {
    const destination = localPath ?? remotePath.split("/").at(-1) ?? "pulled_file";
    const data = this.client.pullFile(remotePath, destination);
    return `Downloaded ${remotePath} → ${destination} (${data.byteLength} bytes)`;
  }

  // ============ System info ============

  async getSystemInfo(): Promise<string> {
    return this.client.getSystemInfo();
  }
}
