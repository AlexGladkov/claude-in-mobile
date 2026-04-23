/**
 * DeviceManager -- thin orchestrator that delegates to platform adapters.
 *
 * Refactored from a 715-line God Object into a ~230-line routing layer.
 * All platform-specific logic lives in src/adapters/*.
 *
 * ISP: The adapters map stores CorePlatformAdapter (the universal contract).
 * Capability-specific operations (app management, permissions, shell) use
 * type guards to narrow before calling.
 *
 * FIX #8: auto-detect device when no deviceId is selected -- see getAdapter().
 */

import type { CorePlatformAdapter } from "./adapters/platform-adapter.js";
import {
  hasAppManagement,
  hasPermissions,
  hasShell,
  hasSyncScreenshot,
} from "./adapters/platform-adapter.js";
import { AndroidAdapter } from "./adapters/android-adapter.js";
import { IosAdapter } from "./adapters/ios-adapter.js";
import { DesktopAdapter } from "./adapters/desktop-adapter.js";
import { AuroraAdapter } from "./adapters/aurora-adapter.js";
import { BrowserAdapter } from "./adapters/browser-adapter.js";

import { AdbClient } from "./adb/client.js";
import { IosClient } from "./ios/client.js";
import { DesktopClient } from "./desktop/client.js";
import type { AuroraClient } from "./aurora/index.js";
import type { CompressOptions } from "./utils/image.js";
import type { LaunchOptions } from "./desktop/types.js";
import { WebViewInspector } from "./adb/webview.js";

export type Platform = "android" | "ios" | "desktop" | "aurora" | "browser";

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  state: string;
  isSimulator: boolean;
}

export class DeviceManager {
  private androidAdapter: AndroidAdapter;
  private iosAdapter: IosAdapter;
  private desktopAdapter: DesktopAdapter;
  private auroraAdapter: AuroraAdapter;
  private browserAdapter: BrowserAdapter;

  private adapters: Map<Platform, CorePlatformAdapter>;
  private activeDevice?: Device;
  private activeTarget: Platform = "android";
  private webViewInspector?: WebViewInspector;

  constructor() {
    const androidDeviceId = process.env.DEVICE_ID ?? process.env.ANDROID_SERIAL ?? undefined;
    const iosDeviceId = process.env.IOS_DEVICE_ID ?? undefined;

    this.androidAdapter = androidDeviceId
      ? new AndroidAdapter(new AdbClient(androidDeviceId))
      : new AndroidAdapter();

    this.iosAdapter = iosDeviceId
      ? new IosAdapter(new IosClient(iosDeviceId))
      : new IosAdapter();

    this.desktopAdapter = new DesktopAdapter();
    this.auroraAdapter = new AuroraAdapter();
    this.browserAdapter = new BrowserAdapter();

    this.adapters = new Map<Platform, CorePlatformAdapter>([
      ["android", this.androidAdapter],
      ["ios", this.iosAdapter],
      ["desktop", this.desktopAdapter],
      ["aurora", this.auroraAdapter],
      ["browser", this.browserAdapter],
    ]);

    // If env var specified a device, set it as active target
    if (androidDeviceId) {
      this.activeTarget = "android";
    } else if (iosDeviceId) {
      this.activeTarget = "ios";
    }
  }

  /**
   * Resolve the correct adapter for a given platform (or the active platform).
   *
   * FIX #8: If the adapter has no selected device, attempt auto-detection.
   * This ensures commands work after a server restart without requiring
   * an explicit set_device call.
   */
  private getAdapter(platform?: Platform): CorePlatformAdapter {
    const target = platform ?? this.activeTarget;
    const adapter = this.adapters.get(target);
    if (!adapter) {
      throw new Error(`Unknown platform: ${target}`);
    }

    // Desktop and Browser return immediately -- the adapter itself guards state
    // where needed (actions, screenshots, UI). Logs/clearLogs work even when stopped.
    if (target === "desktop" || target === "browser") {
      return adapter;
    }

    // FIX #8 -- auto-detect device when none is selected.
    // After a server restart the in-memory deviceId is lost, so we probe
    // the platform for a connected device before the command runs.
    if (!adapter.getSelectedDeviceId()) {
      const detected = adapter.autoDetectDevice();
      if (detected) {
        adapter.selectDevice(detected.id);
        this.activeDevice = detected;
        this.activeTarget = detected.platform;
      }
    }

    return adapter;
  }

  // ============ Target Management ============

  setTarget(target: Platform): void {
    this.activeTarget = target;
  }

  getTarget(): { target: Platform; status: string } {
    if (this.activeTarget === "desktop") {
      const state = this.desktopAdapter.getState();
      return { target: "desktop", status: state.status };
    }

    const device = this.activeDevice;
    if (device) {
      return { target: device.platform, status: device.state };
    }

    return { target: this.activeTarget, status: "no device" };
  }

  // ============ Desktop Specific ============

  async launchDesktopApp(options: LaunchOptions): Promise<string> {
    await this.desktopAdapter.launch(options);
    this.activeTarget = "desktop";
    if (options.projectPath) {
      return `Desktop automation started. Also launching app from ${options.projectPath}`;
    }
    return "Desktop automation started";
  }

  async stopDesktopApp(): Promise<void> {
    await this.desktopAdapter.stop();
  }

  async cleanup(): Promise<void> {
    try { await this.desktopAdapter.stop(); } catch {}
    try { this.iosAdapter.getClient().cleanup(); } catch {}
    try { this.webViewInspector?.cleanup(); } catch {}
    try { await this.browserAdapter.cleanup(); } catch {}
  }

  getBrowserAdapter(): BrowserAdapter {
    return this.browserAdapter;
  }

  getDesktopClient(): DesktopClient {
    return this.desktopAdapter.getClient();
  }

  isDesktopRunning(): boolean {
    return this.desktopAdapter.isRunning();
  }

  // ============ Device Management ============

  getAllDevices(): Device[] {
    const devices: Device[] = [];
    for (const adapter of this.adapters.values()) {
      devices.push(...adapter.listDevices());
    }
    return devices;
  }

  getDevices(platform?: Platform): Device[] {
    if (platform) {
      const adapter = this.adapters.get(platform);
      return adapter ? adapter.listDevices() : [];
    }
    return this.getAllDevices();
  }

  setDevice(deviceId: string, platform?: Platform): Device {
    // Handle desktop special case
    if (deviceId === "desktop" || platform === "desktop") {
      if (!this.desktopAdapter.isRunning()) {
        throw new Error("Desktop app is not running. Use desktop(action:'launch') first.");
      }
      this.activeTarget = "desktop";
      return {
        id: "desktop",
        name: "Desktop App",
        platform: "desktop",
        state: "running",
        isSimulator: false,
      };
    }

    const devices = this.getAllDevices();

    // Find device by ID
    let device = devices.find((d) => d.id === deviceId);

    // If platform specified but device not found, try to match any booted device on that platform
    if (!device && platform) {
      device = devices.find(
        (d) =>
          d.platform === platform &&
          (d.state === "device" || d.state === "booted" || d.state === "connected"),
      );
    }

    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    this.activeDevice = device;
    this.activeTarget = device.platform;

    // Propagate to the adapter
    const adapter = this.adapters.get(device.platform);
    adapter?.selectDevice(device.id);

    return device;
  }

  getActiveDevice(): Device | undefined {
    if (this.activeTarget === "desktop" && this.desktopAdapter.isRunning()) {
      return {
        id: "desktop",
        name: "Desktop App",
        platform: "desktop",
        state: "running",
        isSimulator: false,
      };
    }
    return this.activeDevice;
  }

  getCurrentPlatform(): Platform {
    return this.activeTarget;
  }

  // ============ Unified Commands (delegate to adapters) ============

  async screenshot(
    platform?: Platform,
    compress: boolean = true,
    options?: CompressOptions & { monitorIndex?: number },
  ): Promise<{ data: string; mimeType: string }> {
    return this.screenshotAsync(platform, compress, options);
  }

  async getScreenshotBuffer(platform?: Platform): Promise<Buffer> {
    return this.getScreenshotBufferAsync(platform);
  }

  screenshotRaw(platform?: Platform): string {
    const adapter = this.getAdapter(platform);
    if (!hasSyncScreenshot(adapter)) {
      throw new Error(`screenshotRaw is not supported for ${adapter.platform}. Use screenshotAsync.`);
    }
    return adapter.screenshotRaw();
  }

  async tap(x: number, y: number, platform?: Platform, targetPid?: number): Promise<void> {
    const adapter = this.getAdapter(platform);
    await adapter.tap(x, y, targetPid);
  }

  async doubleTap(
    x: number,
    y: number,
    intervalMs: number = 100,
    platform?: Platform,
  ): Promise<void> {
    const adapter = this.getAdapter(platform);
    await adapter.doubleTap(x, y, intervalMs);
  }

  async longPress(
    x: number,
    y: number,
    durationMs: number = 1000,
    platform?: Platform,
  ): Promise<void> {
    const adapter = this.getAdapter(platform);
    await adapter.longPress(x, y, durationMs);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number = 300,
    platform?: Platform,
  ): Promise<void> {
    const adapter = this.getAdapter(platform);
    await adapter.swipe(x1, y1, x2, y2, durationMs);
  }

  async swipeDirection(
    direction: "up" | "down" | "left" | "right",
    platform?: Platform,
  ): Promise<void> {
    const adapter = this.getAdapter(platform);
    await adapter.swipeDirection(direction);
  }

  async inputText(text: string, platform?: Platform, targetPid?: number): Promise<void> {
    const adapter = this.getAdapter(platform);
    await adapter.inputText(text, targetPid);
  }

  async pressKey(key: string, platform?: Platform, targetPid?: number): Promise<void> {
    const adapter = this.getAdapter(platform);
    await adapter.pressKey(key, targetPid);
  }

  // ============ App management (guarded by type guard) ============

  launchApp(packageOrBundleId: string, platform?: Platform): string {
    const adapter = this.getAdapter(platform);
    if (!hasAppManagement(adapter)) {
      throw new Error(`App management is not supported for ${adapter.platform}. ${
        adapter.platform === "browser" ? "Use browser_open instead." : ""
      }`);
    }
    return adapter.launchApp(packageOrBundleId);
  }

  stopApp(packageOrBundleId: string, platform?: Platform): void {
    const adapter = this.getAdapter(platform);
    if (!hasAppManagement(adapter)) {
      throw new Error(`App management is not supported for ${adapter.platform}. ${
        adapter.platform === "browser" ? "Use browser_close instead." : ""
      }`);
    }
    adapter.stopApp(packageOrBundleId);
  }

  installApp(path: string, platform?: Platform): string {
    const adapter = this.getAdapter(platform);
    if (!hasAppManagement(adapter)) {
      throw new Error(`App installation is not supported for ${adapter.platform}.`);
    }
    return adapter.installApp(path);
  }

  // ============ Permissions (guarded by type guard) ============

  grantPermission(
    packageOrBundleId: string,
    permission: string,
    platform?: Platform,
  ): string {
    const adapter = this.getAdapter(platform);
    if (!hasPermissions(adapter)) {
      throw new Error(
        `Permission management is not supported for ${adapter.platform}. ` +
        `Supported platforms: android, ios.`
      );
    }
    return adapter.grantPermission(packageOrBundleId, permission);
  }

  revokePermission(
    packageOrBundleId: string,
    permission: string,
    platform?: Platform,
  ): string {
    const adapter = this.getAdapter(platform);
    if (!hasPermissions(adapter)) {
      throw new Error(
        `Permission management is not supported for ${adapter.platform}. ` +
        `Supported platforms: android, ios.`
      );
    }
    return adapter.revokePermission(packageOrBundleId, permission);
  }

  resetPermissions(packageOrBundleId: string, platform?: Platform): string {
    const adapter = this.getAdapter(platform);
    if (!hasPermissions(adapter)) {
      throw new Error(
        `Permission management is not supported for ${adapter.platform}. ` +
        `Supported platforms: android, ios.`
      );
    }
    return adapter.resetPermissions(packageOrBundleId);
  }

  // ============ UI ============

  async getUiHierarchy(platform?: Platform): Promise<string> {
    const adapter = this.getAdapter(platform);
    return adapter.getUiHierarchy();
  }

  async getUiHierarchyAsync(platform?: Platform): Promise<string> {
    const adapter = this.getAdapter(platform);
    return adapter.getUiHierarchy();
  }

  // ============ Shell (guarded by type guard) ============

  shell(command: string, platform?: Platform): string {
    const adapter = this.getAdapter(platform);
    if (!hasShell(adapter)) {
      throw new Error(`Shell is not supported for ${adapter.platform}.`);
    }
    return adapter.shell(command);
  }

  // ============ Raw client accessors (used by tools directly) ============

  getAndroidClient(): AdbClient {
    return this.androidAdapter.getClient();
  }

  getIosClient(): IosClient {
    return this.iosAdapter.getClient();
  }

  getAuroraClient(): AuroraClient {
    return this.auroraAdapter.getClient();
  }

  getWebViewInspector(): WebViewInspector {
    if (!this.webViewInspector) {
      this.webViewInspector = new WebViewInspector(this.androidAdapter.getClient());
    }
    return this.webViewInspector;
  }

  // ============ Async screenshot helpers ============

  async screenshotAsync(
    platform?: Platform,
    compress: boolean = true,
    options?: CompressOptions & { monitorIndex?: number },
  ): Promise<{ data: string; mimeType: string }> {
    const adapter = this.getAdapter(platform);
    return adapter.screenshotAsync(compress, options);
  }

  async getScreenshotBufferAsync(platform?: Platform): Promise<Buffer> {
    const adapter = this.getAdapter(platform);
    return adapter.getScreenshotBufferAsync();
  }

  // ============ Logs & System (guarded by type guard) ============

  getLogs(
    options: {
      platform?: Platform;
      level?: string;
      tag?: string;
      lines?: number;
      package?: string;
    } = {},
  ): string {
    const adapter = this.getAdapter(options.platform);
    if (!hasShell(adapter)) {
      throw new Error(`Logs are not supported for ${adapter.platform}.`);
    }
    return adapter.getLogs({
      level: options.level,
      tag: options.tag,
      lines: options.lines,
      package: options.package,
    });
  }

  clearLogs(platform?: Platform): string {
    const adapter = this.getAdapter(platform);
    if (!hasShell(adapter)) {
      throw new Error(`Logs are not supported for ${adapter.platform}.`);
    }
    return adapter.clearLogs();
  }

  async getSystemInfo(platform?: Platform): Promise<string> {
    const adapter = this.getAdapter(platform);
    return adapter.getSystemInfo();
  }
}
