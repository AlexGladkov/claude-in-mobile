/**
 * DeviceManager -- thin orchestrator that delegates to platform adapters.
 *
 * D9.1 split: was a 688-LOC file that mixed routing, default adapter
 * factory, kernel↔adapter bridging, and device resolution. Now a pure
 * facade composing helpers from src/device/:
 *   - client-cache           — default 5-platform adapter factory
 *   - kernel-device-locator  — KernelHandleView bridge
 *   - device-resolver        — listDevices aggregation + deviceId lookup
 *
 * D9.1b split: ~25 thin delegation methods (tap/swipe/launchApp/perms/
 * logs/screenshot/...) extracted into capability proxies under
 * src/device/proxies/. The facade now owns:
 *   - adapter resolution (getAdapter w/ FIX #8 auto-detect)
 *   - target management (set/getTarget, activeDevice/activeTarget)
 *   - desktop lifecycle + cleanup
 *   - device listing/resolution
 *   - legacy raw client accessors (@deprecated)
 * Capability ops are 1-line delegations to the appropriate proxy.
 *
 * Public API of `DeviceManager` and re-exported types (`Platform`,
 * `BuiltinPlatform`, `Device`, `KernelHandleView`, …) is unchanged so
 * the ~125 existing import sites keep compiling.
 *
 * ISP: The adapters map stores CorePlatformAdapter (the universal contract).
 * Capability-specific operations (app management, permissions, shell) use
 * type guards inside proxies to narrow before calling.
 *
 * FIX #8: auto-detect device when no deviceId is selected -- see getAdapter().
 */

import type { CorePlatformAdapter } from "./adapters/platform-adapter.js";
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
import type { RawLaunchOptions } from "./desktop/types.js";
import { WebViewInspector } from "./adb/webview.js";

import type { Device, Platform } from "./platform-types.js";
import { buildDefaultAdapters } from "./device/client-cache.js";
import {
  adaptersFromKernel,
  type KernelHandleView,
} from "./device/kernel-device-locator.js";
import { listAllDevices, resolveDevice } from "./device/device-resolver.js";
import { InputProxy } from "./device/proxies/input-proxy.js";
import { AppProxy } from "./device/proxies/app-proxy.js";
import { PermissionProxy } from "./device/proxies/permission-proxy.js";
import { LogProxy } from "./device/proxies/log-proxy.js";
import { ScreenProxy } from "./device/proxies/screen-proxy.js";

// Re-export platform types so the ~125 existing call sites that import
// `Platform`, `Device`, `BuiltinPlatform`, etc. from "./device-manager.js"
// keep working without churn.
export type { BuiltinPlatform, Platform, Device } from "./platform-types.js";
export {
  BUILTIN_PLATFORMS,
  isBuiltinPlatform,
  assertNever,
} from "./platform-types.js";
export type { KernelHandleView } from "./device/kernel-device-locator.js";

export interface DeviceManagerConfig {
  adapters: Map<Platform, CorePlatformAdapter>;
  activeTarget?: Platform;
}

export class DeviceManager {
  private adapters: Map<Platform, CorePlatformAdapter>;
  private activeDevice?: Device;
  private activeTarget: Platform = "android";
  private webViewInspector?: WebViewInspector;

  private readonly inputProxy: InputProxy;
  private readonly appProxy: AppProxy;
  private readonly permissionProxy: PermissionProxy;
  private readonly logProxy: LogProxy;
  private readonly screenProxy: ScreenProxy;

  /**
   * Build a DeviceManager whose adapters come from the microkernel registry.
   * See `kernel-device-locator.ts` for the bridging logic.
   */
  static fromKernel(
    handle: KernelHandleView,
    activeTarget: Platform = "android",
  ): DeviceManager {
    return new DeviceManager({ adapters: adaptersFromKernel(handle), activeTarget });
  }

  constructor(config?: DeviceManagerConfig) {
    if (config) {
      this.adapters = config.adapters;
      this.activeTarget = config.activeTarget ?? "android";
    } else {
      const { adapters, envSeededTarget } = buildDefaultAdapters();
      this.adapters = adapters;
      if (envSeededTarget) {
        this.activeTarget = envSeededTarget;
      }
    }

    const resolver = (platform?: Platform, deviceId?: string) =>
      this.getAdapter(platform, deviceId);
    this.inputProxy = new InputProxy(resolver);
    this.appProxy = new AppProxy(resolver);
    this.permissionProxy = new PermissionProxy(resolver);
    this.logProxy = new LogProxy(resolver);
    this.screenProxy = new ScreenProxy(resolver);
  }

  /**
   * Resolve a platform's CorePlatformAdapter.
   *
   * Phase 3 of the abstraction refactor: tools should depend on the
   * capability-segregated interfaces here (CorePlatformAdapter +
   * AppManagementAdapter / PermissionAdapter / ShellAdapter via type guards)
   * rather than the legacy `getAndroidClient()/getIosClient()/...` accessors.
   *
   * FIX #8: If the adapter has no selected device, attempt auto-detection.
   * When deviceId is provided, auto-detect is skipped and global state is
   * NOT mutated.
   */
  getAdapter(platform?: Platform, deviceId?: string): CorePlatformAdapter {
    const target = platform ?? this.activeTarget;
    const adapter = this.adapters.get(target);
    if (!adapter) {
      throw new Error(`Unknown platform: ${target}`);
    }
    if (target === "desktop" || target === "browser") return adapter;
    if (deviceId) return adapter;
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
        return { target: "desktop", status: desktop.getState().status };
      }
      return { target: "desktop", status: "not available" };
    }
    const device = this.activeDevice;
    if (device) return { target: device.platform, status: device.state };
    return { target: this.activeTarget, status: "no device" };
  }

  // ============ Desktop Specific ============

  async launchDesktopApp(options: RawLaunchOptions): Promise<string> {
    const desktop = this.adapters.get("desktop");
    if (!desktop || !(desktop instanceof DesktopAdapter)) {
      throw new Error("Desktop adapter is not available in this configuration.");
    }
    await desktop.launch(options);
    this.activeTarget = "desktop";
    if (options.mode === "bundle") {
      const target = options.bundleId ?? options.appPath ?? "app";
      return `Desktop automation started. App launched: ${target}`;
    }
    if (options.mode === "attach" && options.pid !== undefined) {
      return `Desktop automation started. Attached to process PID ${options.pid}`;
    }
    if (options.projectPath) {
      return `Desktop automation started. Also launching app from ${options.projectPath}`;
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

  // ============ Device Management (delegates to device-resolver) ============

  getAllDevicesWithErrors(): { devices: Device[]; errors: { platform: Platform; error: Error }[] } {
    return listAllDevices(this.adapters);
  }

  getAllDevices(): Device[] {
    return listAllDevices(this.adapters).devices;
  }

  getDevices(platform?: Platform): Device[] {
    if (platform) {
      const adapter = this.adapters.get(platform);
      return adapter ? adapter.listDevices() : [];
    }
    return this.getAllDevices();
  }

  setDevice(deviceId: string, platform?: Platform): Device {
    if (deviceId === "desktop" || platform === "desktop") {
      if (!this.isDesktopRunning()) {
        throw new Error("Desktop app is not running. Use desktop(action:'launch') first.");
      }
      this.activeTarget = "desktop";
      return { id: "desktop", name: "Desktop App", platform: "desktop", state: "running", isSimulator: false };
    }
    const listing = listAllDevices(this.adapters);
    const { device } = resolveDevice(deviceId, platform, listing);
    this.activeDevice = device;
    this.activeTarget = device.platform;
    this.adapters.get(device.platform)?.selectDevice(device.id);
    return device;
  }

  getActiveDevice(): Device | undefined {
    if (this.activeTarget === "desktop" && this.isDesktopRunning()) {
      return { id: "desktop", name: "Desktop App", platform: "desktop", state: "running", isSimulator: false };
    }
    return this.activeDevice;
  }

  getCurrentPlatform(): Platform {
    return this.activeTarget;
  }

  // ============ Screen ops (proxy) ============

  async screenshot(
    platform?: Platform,
    compress: boolean = true,
    options?: CompressOptions & { monitorIndex?: number },
    deviceId?: string,
  ): Promise<{ data: string; mimeType: string }> {
    return this.screenProxy.screenshot(platform, compress, options, deviceId);
  }

  async getScreenshotBuffer(platform?: Platform, deviceId?: string): Promise<Buffer> {
    return this.screenProxy.getScreenshotBuffer(platform, deviceId);
  }

  screenshotRaw(platform?: Platform): string {
    return this.screenProxy.screenshotRaw(platform);
  }

  async screenshotAsync(
    platform?: Platform,
    compress: boolean = true,
    options?: CompressOptions & { monitorIndex?: number },
    deviceId?: string,
  ): Promise<{ data: string; mimeType: string }> {
    return this.screenProxy.screenshotAsync(platform, compress, options, deviceId);
  }

  async getScreenshotBufferAsync(platform?: Platform, deviceId?: string): Promise<Buffer> {
    return this.screenProxy.getScreenshotBufferAsync(platform, deviceId);
  }

  async getUiHierarchy(platform?: Platform, deviceId?: string, turbo?: boolean): Promise<string> {
    return this.screenProxy.getUiHierarchy(platform, deviceId, turbo);
  }

  async getUiHierarchyAsync(platform?: Platform, deviceId?: string, turbo?: boolean): Promise<string> {
    return this.screenProxy.getUiHierarchy(platform, deviceId, turbo);
  }

  // ============ Input ops (proxy) ============

  async tap(x: number, y: number, platform?: Platform, targetPid?: number, deviceId?: string): Promise<void> {
    return this.inputProxy.tap(x, y, platform, targetPid, deviceId);
  }

  async doubleTap(x: number, y: number, intervalMs: number = 100, platform?: Platform, deviceId?: string): Promise<void> {
    return this.inputProxy.doubleTap(x, y, intervalMs, platform, deviceId);
  }

  async longPress(x: number, y: number, durationMs: number = 1000, platform?: Platform, deviceId?: string): Promise<void> {
    return this.inputProxy.longPress(x, y, durationMs, platform, deviceId);
  }

  async swipe(
    x1: number, y1: number, x2: number, y2: number,
    durationMs: number = 300, platform?: Platform, deviceId?: string,
  ): Promise<void> {
    return this.inputProxy.swipe(x1, y1, x2, y2, durationMs, platform, deviceId);
  }

  async swipeDirection(
    direction: "up" | "down" | "left" | "right",
    platform?: Platform, deviceId?: string,
  ): Promise<void> {
    return this.inputProxy.swipeDirection(direction, platform, deviceId);
  }

  async inputText(text: string, platform?: Platform, targetPid?: number, deviceId?: string): Promise<void> {
    return this.inputProxy.inputText(text, platform, targetPid, deviceId);
  }

  async pressKey(key: string, platform?: Platform, targetPid?: number, deviceId?: string): Promise<void> {
    return this.inputProxy.pressKey(key, platform, targetPid, deviceId);
  }

  // ============ App ops (proxy) ============

  async launchApp(packageOrBundleId: string, platform?: Platform, deviceId?: string): Promise<string> {
    return this.appProxy.launchApp(packageOrBundleId, platform, deviceId);
  }

  stopApp(packageOrBundleId: string, platform?: Platform, deviceId?: string): void {
    this.appProxy.stopApp(packageOrBundleId, platform, deviceId);
  }

  installApp(path: string, platform?: Platform, deviceId?: string): string {
    return this.appProxy.installApp(path, platform, deviceId);
  }

  // ============ Permission ops (proxy) ============

  grantPermission(packageOrBundleId: string, permission: string, platform?: Platform, deviceId?: string): string {
    return this.permissionProxy.grantPermission(packageOrBundleId, permission, platform, deviceId);
  }

  revokePermission(packageOrBundleId: string, permission: string, platform?: Platform, deviceId?: string): string {
    return this.permissionProxy.revokePermission(packageOrBundleId, permission, platform, deviceId);
  }

  resetPermissions(packageOrBundleId: string, platform?: Platform, deviceId?: string): string {
    return this.permissionProxy.resetPermissions(packageOrBundleId, platform, deviceId);
  }

  // ============ Shell / Logs / System (proxy) ============

  shell(command: string, platform?: Platform, deviceId?: string): string {
    return this.logProxy.shell(command, platform, deviceId);
  }

  getLogs(
    options: {
      platform?: Platform; level?: string; tag?: string;
      lines?: number; package?: string; deviceId?: string;
    } = {},
  ): string {
    return this.logProxy.getLogs(options);
  }

  clearLogs(platform?: Platform, deviceId?: string): string {
    return this.logProxy.clearLogs(platform, deviceId);
  }

  async getSystemInfo(platform?: Platform, deviceId?: string): Promise<string> {
    return this.logProxy.getSystemInfo(platform, deviceId);
  }

  // ============ Raw client accessors (legacy — prefer getAdapter + capability guards) ============

  /** @deprecated Use `getAdapter("android", deviceId)` + capability type guards from `adapters/platform-adapter.ts`. */
  getAndroidClient(deviceId?: string): AdbClient {
    const adapter = this.adapters.get("android");
    if (!adapter || !(adapter instanceof AndroidAdapter)) {
      throw new Error("Android adapter is not available in this configuration.");
    }
    return adapter.getClient(deviceId);
  }

  /** @deprecated Use `getAdapter("ios", deviceId)` + capability type guards. */
  getIosClient(deviceId?: string): IosClient {
    const adapter = this.adapters.get("ios");
    if (!adapter || !(adapter instanceof IosAdapter)) {
      throw new Error("iOS adapter is not available in this configuration.");
    }
    return adapter.getClient(deviceId);
  }

  /** @deprecated Use `getAdapter("aurora")` + capability type guards. */
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
}

/** Factory for full DeviceManager with all 5 adapters (backward compat). */
export function createFullDeviceManager(): DeviceManager {
  return new DeviceManager();
}
