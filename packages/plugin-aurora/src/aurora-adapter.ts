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
  LogsAdapter,
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
    LogsAdapter,
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

  async tap(x: number, y: number, _targetPid?: number, deviceId?: string): Promise<void> {
    this.client.tap(x, y, deviceId);
  }

  async doubleTap(x: number, y: number, intervalMs: number = 100, deviceId?: string): Promise<void> {
    // Aurora: two taps with interval
    this.client.tap(x, y, deviceId);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    this.client.tap(x, y, deviceId);
  }

  async longPress(x: number, y: number, durationMs: number = 1000, deviceId?: string): Promise<void> {
    this.client.longPress(x, y, durationMs, deviceId);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number,
    deviceId?: string,
  ): Promise<void> {
    this.client.swipe(x1, y1, x2, y2, durationMs, deviceId);
  }

  async swipeDirection(direction: "up" | "down" | "left" | "right", deviceId?: string): Promise<void> {
    this.client.swipeDirection(direction, deviceId);
  }

  async inputText(text: string, _targetPid?: number, deviceId?: string): Promise<void> {
    this.client.inputText(text, deviceId);
  }

  async pressKey(key: string, _targetPid?: number, deviceId?: string): Promise<void> {
    this.client.pressKey(key, deviceId);
  }

  // ============ Screenshot ============

  async screenshotAsync(
    compress: boolean = true,
    options?: CompressOptions & { monitorIndex?: number },
    deviceId?: string,
  ): Promise<{ data: string; mimeType: string }> {
    const buffer = this.client.screenshotRaw(deviceId);
    if (compress) {
      return compressScreenshot(buffer, options);
    }
    return { data: buffer.toString("base64"), mimeType: "image/png" };
  }

  async getScreenshotBufferAsync(deviceId?: string): Promise<Buffer> {
    return this.client.screenshotRaw(deviceId);
  }

  screenshotRaw(deviceId?: string): string {
    return this.client.screenshot(deviceId);
  }

  // ============ UI ============

  async getUiHierarchy(deviceId?: string): Promise<string> {
    return this.client.getUiHierarchy(deviceId);
  }

  // ============ App management (AppManagementAdapter) ============

  launchApp(packageName: string, deviceId?: string): string {
    return this.client.launchApp(packageName, deviceId);
  }

  stopApp(packageName: string, deviceId?: string): void {
    this.client.stopApp(packageName, deviceId);
  }

  installApp(path: string, deviceId?: string): string {
    return this.client.installApp(path, deviceId);
  }

  // ============ App inventory (AppInventoryAdapter) ============

  listApps(deviceId?: string): string[] {
    return this.client.listPackages(deviceId);
  }

  uninstallApp(packageName: string, deviceId?: string): string {
    return this.client.uninstallApp(packageName, deviceId);
  }

  // ============ Shell / Logs (ShellAdapter) ============

  shell(command: string, deviceId?: string): string {
    return this.client.shell(command, deviceId);
  }

  getLogs(options: {
    level?: string;
    tag?: string;
    lines?: number;
    package?: string;
  } = {}, deviceId?: string): string {
    return this.client.getLogs(options, deviceId);
  }

  clearLogs(deviceId?: string): string {
    return this.client.clearLogs(deviceId);
  }

  // ============ File transfer (FileTransferAdapter) ============

  pushFile(localPath: string, remotePath: string, deviceId?: string): string {
    return this.client.pushFile(localPath, remotePath, deviceId);
  }

  pullFile(remotePath: string, localPath?: string, deviceId?: string): string {
    const destination = localPath ?? remotePath.split("/").at(-1) ?? "pulled_file";
    const data = this.client.pullFile(remotePath, destination, deviceId);
    return `Downloaded ${remotePath} → ${destination} (${data.byteLength} bytes)`;
  }

  // ============ System info ============

  async getSystemInfo(deviceId?: string): Promise<string> {
    return this.client.getSystemInfo(deviceId);
  }
}
