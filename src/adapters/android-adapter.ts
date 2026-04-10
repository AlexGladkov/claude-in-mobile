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
    this._selectedDeviceId = this.client.getDeviceId();
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

  async launchApp(packageName: string): Promise<string> {
    return this.client.launchApp(packageName);
  }

  async stopApp(packageName: string): Promise<void> {
    this.client.stopApp(packageName);
  }

  async installApp(path: string): Promise<string> {
    return this.client.installApk(path);
  }

  async uninstallApp(packageName: string): Promise<string> {
    return this.client.uninstallApp(packageName);
  }

  // ============ Permissions ============

  async grantPermission(packageName: string, permission: string): Promise<string> {
    this.client.grantPermission(packageName, permission);
    return `Granted ${permission} to ${packageName}`;
  }

  async revokePermission(packageName: string, permission: string): Promise<string> {
    this.client.revokePermission(packageName, permission);
    return `Revoked ${permission} from ${packageName}`;
  }

  async resetPermissions(packageName: string): Promise<string> {
    this.client.resetPermissions(packageName);
    return `Reset permissions for ${packageName}`;
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
    return this.client.getLogs({
      level: options.level as "V" | "D" | "I" | "W" | "E" | "F" | undefined,
      tag: options.tag,
      lines: options.lines,
      package: options.package,
    });
  }

  async clearLogs(): Promise<string> {
    this.client.clearLogs();
    return "Logcat buffer cleared";
  }

  async getSystemInfo(): Promise<string> {
    const battery = this.client.getBatteryInfo();
    const memory = this.client.getMemoryInfo();
    return `=== Battery ===\n${battery}\n\n=== Memory ===\n${memory}`;
  }

  // ============ App Listing ============

  async getAppList(): Promise<Array<{
    appName: string;
    packageName: string;
    versionName?: string;
    versionCode?: string;
  }>> {
    // Use ADB to list installed packages
    const output = this.client.shell("pm list packages -f");
    const lines = output.trim().split("\n");
    const apps: Array<{
      appName: string;
      packageName: string;
      versionName?: string;
      versionCode?: string;
    }> = [];

    for (const line of lines) {
      // Parse package:path=package.name format
      const match = line.match(/package:(.+?)=(.+)/);
      if (match) {
        const packageName = match[2];
        // Try to get app name from package name (simplified)
        const appName = packageName.split(".").pop() || packageName;
        apps.push({ appName, packageName });
      }
    }

    return apps;
  }

  // ============ Clipboard Operations ============

  async setClipboard(text: string): Promise<void> {
    this.client.setClipboardText(text);
  }

  async getClipboard(): Promise<string> {
    return this.client.getClipboardText();
  }

  // ============ WebView Inspection ============

  async getWebViews(): Promise<Array<{ packageName?: string; socket?: string; [key: string]: any }>> {
    // Use the WebViewInspector to get WebView information
    const inspector = new (await import("../adb/webview.js")).WebViewInspector(this.client);
    const result = await inspector.inspect();
    return result.targets.map(t => ({
      packageName: t.url,
      socket: result.sockets[0],
      ...t
    }));
  }
}
