import type {
  AppInventoryAdapter,
  AppManagementAdapter,
  CorePlatformAdapter,
  FileTransferAdapter,
  LogsAdapter,
  PermissionAdapter,
  ShellAdapter,
  SyncScreenshotAdapter,
  UrlOpeningAdapter,
} from "mcp-devices/adapters/platform-adapter";
import type { Device } from "mcp-devices/device-manager";
import { compressScreenshot } from "mcp-devices/utils/image";
import type { CompressOptions } from "mcp-devices/utils/image";

import { HdcClient } from "./client.js";

export class HarmonyAdapter
  implements
    CorePlatformAdapter,
    AppManagementAdapter,
    AppInventoryAdapter,
    PermissionAdapter,
    ShellAdapter,
    LogsAdapter,
    FileTransferAdapter,
    UrlOpeningAdapter,
    SyncScreenshotAdapter
{
  readonly platform = "harmony" as const;

  constructor(private readonly client: HdcClient = new HdcClient()) {}

  getClient(): HdcClient {
    return this.client;
  }

  listDevices(): Device[] {
    return this.client.listDevices();
  }

  selectDevice(deviceId: string): void {
    this.client.setDevice(deviceId);
  }

  getSelectedDeviceId(): string | undefined {
    return this.client.getDeviceId();
  }

  autoDetectDevice(): Device | undefined {
    return this.listDevices().find((device) =>
      device.state === "connected" || device.state === "ready"
    );
  }

  async tap(x: number, y: number, _targetPid?: number, deviceId?: string): Promise<void> {
    this.client.tap(x, y, deviceId);
  }

  async doubleTap(
    x: number,
    y: number,
    _intervalMs = 100,
    deviceId?: string,
  ): Promise<void> {
    this.client.doubleTap(x, y, deviceId);
  }

  async longPress(
    x: number,
    y: number,
    durationMs = 1_000,
    deviceId?: string,
  ): Promise<void> {
    this.client.longPress(x, y, durationMs, deviceId);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 300,
    deviceId?: string,
  ): Promise<void> {
    this.client.swipe(x1, y1, x2, y2, durationMs, deviceId);
  }

  async swipeDirection(
    direction: "up" | "down" | "left" | "right",
    deviceId?: string,
  ): Promise<void> {
    this.client.swipeDirection(direction, deviceId);
  }

  async inputText(
    text: string,
    _targetPid?: number,
    deviceId?: string,
  ): Promise<void> {
    this.client.inputText(text, deviceId);
  }

  async pressKey(
    key: string,
    _targetPid?: number,
    deviceId?: string,
  ): Promise<void> {
    this.client.pressKey(key, deviceId);
  }

  async screenshotAsync(
    compress = true,
    options?: CompressOptions & { monitorIndex?: number },
    deviceId?: string,
  ): Promise<{ data: string; mimeType: string }> {
    const buffer = this.client.screenshotRaw(deviceId);
    if (compress) return compressScreenshot(buffer, options);
    return { data: buffer.toString("base64"), mimeType: "image/png" };
  }

  async getScreenshotBufferAsync(deviceId?: string): Promise<Buffer> {
    return this.client.screenshotRaw(deviceId);
  }

  screenshotRaw(): string {
    return this.client.screenshot();
  }

  async getUiHierarchy(deviceId?: string): Promise<string> {
    return this.client.getUiHierarchy(deviceId);
  }

  launchApp(target: string, deviceId?: string): string {
    return this.client.launchApp(target, deviceId);
  }

  stopApp(bundleId: string, deviceId?: string): void {
    this.client.stopApp(bundleId, deviceId);
  }

  installApp(path: string, deviceId?: string): string {
    return this.client.installApp(path, deviceId);
  }

  launchAbility(
    bundleId: string,
    ability = "EntryAbility",
    moduleName?: string,
    deviceId?: string,
  ): string {
    return this.client.launchAbility(bundleId, ability, moduleName, deviceId);
  }

  listApps(deviceId?: string): string[] {
    return this.client.listPackages(deviceId);
  }

  uninstallApp(bundleId: string, deviceId?: string): string {
    return this.client.uninstallApp(bundleId, deviceId);
  }

  pushFile(localPath: string, remotePath: string, deviceId?: string): string {
    return this.client.pushFile(localPath, remotePath, deviceId);
  }

  pullFile(remotePath: string, localPath?: string, deviceId?: string): string {
    const destination = localPath ?? remotePath.split("/").at(-1) ?? "pulled_file";
    return this.client.pullFile(remotePath, destination, deviceId);
  }

  grantPermission(bundleId: string, permission: string, deviceId?: string): string {
    return this.client.grantPermission(bundleId, permission, deviceId);
  }

  revokePermission(bundleId: string, permission: string, deviceId?: string): string {
    return this.client.revokePermission(bundleId, permission, deviceId);
  }

  resetPermissions(bundleId: string, deviceId?: string): string {
    return this.client.resetPermissions(bundleId, deviceId);
  }

  openUrl(url: string, deviceId?: string): string {
    return this.client.openUrl(url, deviceId);
  }

  shell(command: string, deviceId?: string): string {
    return this.client.shell(command, deviceId);
  }

  getLogs(
    options: { level?: string; tag?: string; lines?: number; package?: string } = {},
    deviceId?: string,
  ): string {
    return this.client.getLogs(options, deviceId);
  }

  clearLogs(deviceId?: string): string {
    return this.client.clearLogs(deviceId);
  }

  async getSystemInfo(deviceId?: string): Promise<string> {
    return this.client.getSystemInfo(deviceId);
  }

  dispose(): void {
    this.client.dispose();
  }
}
