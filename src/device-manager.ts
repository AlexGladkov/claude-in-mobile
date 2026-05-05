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

export interface DeviceManagerConfig {
  adapters: Map<Platform, CorePlatformAdapter>;
  activeTarget?: Platform;
}

export class DeviceManager {
  private adapters: Map<Platform, CorePlatformAdapter>;
  private activeDevice?: Device;
  private activeTarget: Platform = "android";
  private webViewInspector?: WebViewInspector;

  constructor(config?: DeviceManagerConfig) {
    if (config) {
      this.adapters = config.adapters;
      this.activeTarget = config.activeTarget ?? "android";
      return;
    }

    // Default: create all 5 adapters (full mode)
    const androidDeviceId = process.env.DEVICE_ID ?? process.env.ANDROID_SERIAL ?? undefined;
    const iosDeviceId = process.env.IOS_DEVICE_ID ?? undefined;

    const androidAdapter = androidDeviceId
      ? new AndroidAdapter(new AdbClient(androidDeviceId))
      : new AndroidAdapter();

    const iosAdapter = iosDeviceId
      ? new IosAdapter(new IosClient(iosDeviceId))
      : new IosAdapter();

    const desktopAdapter = new DesktopAdapter();
    const auroraAdapter = new AuroraAdapter();
    const browserAdapter = new BrowserAdapter();

    this.adapters = new Map<Platform, CorePlatformAdapter>([
      ["android", androidAdapter],
      ["ios", iosAdapter],
      ["desktop", desktopAdapter],
      ["aurora", auroraAdapter],
      ["browser", browserAdapter],
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
      const desktop = this.adapters.get("desktop");
      if (desktop instanceof DesktopAdapter) {
        const state = desktop.getState();
        return { target: "desktop", status: state.status };
      }
      return { target: "desktop", status: "not available" };
    }

    const device = this.activeDevice;
    if (device) {
      return { target: device.platform, status: device.state };
    }

    return { target: this.activeTarget, status: "no device" };
  }

  // ============ Desktop Specific ============

  async launchDesktopApp(options: LaunchOptions): Promise<string> {
    const desktop = this.adapters.get("desktop");
    if (!desktop || !(desktop instanceof DesktopAdapter)) {
      throw new Error("Desktop adapter is not available in this configuration.");
    }
    await desktop.launch(options);
    this.activeTarget = "desktop";
    const client = desktop.getClient();
    if (options.projectPath) {
      return `Desktop automation started. Also launching app from ${options.projectPath}`;
    }
    if (options.bundleId || options.appPath) {
      const app = options.bundleId || options.appPath;
      const pid = client.targetPid;
      return `Desktop automation started. Launched native app: ${app}${pid ? ` (PID: ${pid})` : ""}`;
    }
    if (options.pid) {
      return `Desktop automation started. Attached to process PID: ${options.pid}`;
    }
    return "Desktop automation started (companion only)";
  }

  async stopDesktopApp(): Promise<void> {
    const desktop = this.adapters.get("desktop");
    if (!desktop || !(desktop instanceof DesktopAdapter)) {
      throw new Error("Desktop adapter is not available in this configuration.");
    }
    await desktop.stop();
  }

  async cleanup(): Promise<void> {
    const desktop = this.adapters.get("desktop");
    if (desktop instanceof DesktopAdapter) {
      try { await desktop.stop(); } catch {}
    }
    const ios = this.adapters.get("ios");
    if (ios instanceof IosAdapter) {
      try { ios.getClient().cleanup(); } catch {}
    }
    try { this.webViewInspector?.cleanup(); } catch {}
    const browser = this.adapters.get("browser");
    if (browser instanceof BrowserAdapter) {
      try { await browser.cleanup(); } catch {}
    }
  }

  getBrowserAdapter(): BrowserAdapter {
    const adapter = this.adapters.get("browser");
    if (!adapter || !(adapter instanceof BrowserAdapter)) {
      throw new Error("Browser adapter is not available in this configuration.");
    }
    return adapter;
  }

  getDesktopClient(): DesktopClient {
    const adapter = this.adapters.get("desktop");
    if (!adapter || !(adapter instanceof DesktopAdapter)) {
      throw new Error("Desktop adapter is not available in this configuration.");
    }
    return adapter.getClient();
  }

  isDesktopRunning(): boolean {
    const adapter = this.adapters.get("desktop");
    if (!adapter || !(adapter instanceof DesktopAdapter)) return false;
    return adapter.isRunning();
  }

  // ============ Device Management ============

  /**
   * Aggregate device list across adapters. Captures structural errors (e.g.
   * ADB_NOT_INSTALLED) per-platform so callers can surface root cause instead of
   * an empty list. Returns devices found and a parallel `errors` array.
   */
  getAllDevicesWithErrors(): { devices: Device[]; errors: { platform: Platform; error: Error }[] } {
    const devices: Device[] = [];
    const errors: { platform: Platform; error: Error }[] = [];
    for (const [platform, adapter] of this.adapters.entries()) {
      try {
        devices.push(...adapter.listDevices());
      } catch (e) {
        errors.push({ platform, error: e instanceof Error ? e : new Error(String(e)) });
      }
    }
    return { devices, errors };
  }

  getAllDevices(): Device[] {
    return this.getAllDevicesWithErrors().devices;
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
      if (!this.isDesktopRunning()) {
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

    const { devices, errors } = this.getAllDevicesWithErrors();

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
      // If a target platform's adapter failed structurally (e.g. ADB_NOT_INSTALLED), surface
      // that — `Device not found` is misleading when the real cause is the toolchain itself.
      const relevant = platform
        ? errors.find((e) => e.platform === platform)
        : errors[0];
      if (relevant) throw relevant.error;
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
    if (this.activeTarget === "desktop" && this.isDesktopRunning()) {
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

  async launchApp(packageOrBundleId: string, platform?: Platform): Promise<string> {
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
    const adapter = this.adapters.get("android");
    if (!adapter || !(adapter instanceof AndroidAdapter)) {
      throw new Error("Android adapter is not available in this configuration.");
    }
    return adapter.getClient();
  }

  getIosClient(): IosClient {
    const adapter = this.adapters.get("ios");
    if (!adapter || !(adapter instanceof IosAdapter)) {
      throw new Error("iOS adapter is not available in this configuration.");
    }
    return adapter.getClient();
  }

  getAuroraClient(): AuroraClient {
    const adapter = this.adapters.get("aurora");
    if (!adapter || !(adapter instanceof AuroraAdapter)) {
      throw new Error("Aurora adapter is not available in this configuration.");
    }
    return adapter.getClient();
  }

  getWebViewInspector(): WebViewInspector {
    if (!this.webViewInspector) {
      this.webViewInspector = new WebViewInspector(this.getAndroidClient());
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

/** Factory for full DeviceManager with all 5 adapters (backward compat). */
export function createFullDeviceManager(): DeviceManager {
  return new DeviceManager();
}
