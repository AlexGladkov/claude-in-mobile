/**
 * DeviceManager -- delegates device routing to explicitly supplied adapters.
 *
 * Adapters come from a caller-provided map or a bootstrapped plugin kernel.
 * Plugin loading is asynchronous, so this module does not construct a
 * synchronous implicit "full" manager.
 *
 * Capability proxies live under `src/device/proxies/`; kernel bridging and
 * device resolution live under `src/device/`.
 *
 * Platform types remain re-exported for the existing import sites.
 */

import type { CorePlatformAdapter } from "./adapters/platform-adapter.js";
import type { AdbClientLike, AuroraClientLike, BrowserAdapterLike, IosClientLike, WebViewInspectorLike } from "./adapters/contracts.js";

import type { CompressOptions } from "./utils/image.js";
import type { DesktopClientLike, RawLaunchOptionsLike } from "./adapters/contracts.js";

import type { Device, Platform } from "./platform-types.js";
import { adaptersFromKernel } from "./device/kernel-device-locator.js";
import type { KernelHandleView } from "./device/kernel-device-locator.js";
import { InputProxy } from "./device/proxies/input-proxy.js";
import { AppProxy } from "./device/proxies/app-proxy.js";
import { PermissionProxy } from "./device/proxies/permission-proxy.js";
import { LogProxy } from "./device/proxies/log-proxy.js";
import { FileTransferProxy } from "./device/proxies/file-transfer-proxy.js";
import { ScreenProxy } from "./device/proxies/screen-proxy.js";
import { DesktopFacade } from "./device/proxies/desktop-facade.js";
import { DeviceFacade } from "./device/proxies/device-facade.js";
import { sanitizeErrorMessage } from "./utils/sanitize.js";

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
  /** Whether this manager, rather than a plugin kernel, owns adapter teardown. */
  ownsAdapters?: boolean;
}

function defaultInitialTarget(
  adapters: ReadonlyMap<Platform, CorePlatformAdapter>,
): Platform {
  for (const [platform, adapter] of adapters) {
    if (adapter.getSelectedDeviceId()) return platform;
  }
  if (adapters.has("android")) return "android";
  return adapters.keys().next().value ?? "android";
}

export class DeviceManager {
  private adapters: Map<Platform, CorePlatformAdapter>;
  private readonly ownsAdapters: boolean;
  private cleanupPromise?: Promise<void>;

  private readonly inputProxy: InputProxy;
  private readonly appProxy: AppProxy;
  private readonly permissionProxy: PermissionProxy;
  private readonly logProxy: LogProxy;
  private readonly fileTransferProxy: FileTransferProxy;
  private readonly screenProxy: ScreenProxy;
  private readonly desktopFacade: DesktopFacade;
  private readonly deviceFacade: DeviceFacade;

  /**
   * Build a DeviceManager whose adapters come from the microkernel registry.
   * See `kernel-device-locator.ts` for the bridging logic.
   */
  static fromKernel(
    handle: KernelHandleView,
    activeTarget?: Platform,
  ): DeviceManager {
    return new DeviceManager({
      adapters: adaptersFromKernel(handle),
      activeTarget,
      ownsAdapters: false,
    });
  }

  constructor(config: DeviceManagerConfig = { adapters: new Map() }) {
    this.adapters = config.adapters;
    this.ownsAdapters = config.ownsAdapters ?? true;
    const initialTarget = config.activeTarget ?? defaultInitialTarget(this.adapters);

    this.desktopFacade = new DesktopFacade(this.adapters);
    this.deviceFacade = new DeviceFacade(this.adapters, this.desktopFacade, initialTarget);

    const resolver = (platform?: Platform, deviceId?: string) =>
      this.getAdapter(platform, deviceId);
    this.inputProxy = new InputProxy(resolver);
    this.appProxy = new AppProxy(resolver);
    this.permissionProxy = new PermissionProxy(resolver);
    this.logProxy = new LogProxy(resolver);
    this.fileTransferProxy = new FileTransferProxy(resolver);
    this.screenProxy = new ScreenProxy(resolver);
  }

  /**
   * Resolve a platform's CorePlatformAdapter.
   *
   * FIX #8: If the adapter has no selected device, attempt auto-detection.
   * When deviceId is provided, auto-detect is skipped and global state is
   * NOT mutated.
   */
  getAdapter(platform?: Platform, deviceId?: string): CorePlatformAdapter {
    const target = platform ?? this.deviceFacade.getCurrentPlatform();
    const adapter = this.adapters.get(target);
    if (!adapter) {
      const available = [...this.adapters.keys()].join(", ") || "none";
      throw new Error(
        `Platform '${target}' is not installed. ` +
          `Enable it with \`mcp-devices install ${target}\` ` +
          `(or set MCP_DEVICES_PLATFORMS=${target}). ` +
          `Currently available: ${available}.`
      );
    }
    if (target === "desktop" || target === "browser") return adapter;
    if (deviceId) return adapter;
    if (!adapter.getSelectedDeviceId()) {
      const detected = adapter.autoDetectDevice();
      if (detected) {
        adapter.selectDevice(detected.id);
        this.deviceFacade.recordAutoDetected(detected);
      }
    }
    return adapter;
  }

  // ============ Target / Device Management (delegates to DeviceFacade) ============

  setTarget(target: Platform): void { this.deviceFacade.setTarget(target); }
  getTarget(): { target: Platform; status: string } { return this.deviceFacade.getTarget(); }
  getAllDevicesWithErrors() { return this.deviceFacade.getAllDevicesWithErrors(); }
  getAllDevices(): Device[] { return this.deviceFacade.getAllDevices(); }
  getDevices(platform?: Platform): Device[] { return this.deviceFacade.getDevices(platform); }
  setDevice(deviceId: string, platform?: Platform): Device { return this.deviceFacade.setDevice(deviceId, platform); }
  getActiveDevice(): Device | undefined { return this.deviceFacade.getActiveDevice(); }
  getCurrentPlatform(): Platform { return this.deviceFacade.getCurrentPlatform(); }

  // ============ Desktop / Browser (delegates to DesktopFacade) ============

  async launchDesktopApp(options: RawLaunchOptionsLike): Promise<string> {
    const msg = await this.desktopFacade.launch(options);
    this.deviceFacade.setTarget("desktop");
    return msg;
  }

  async stopDesktopApp(): Promise<void> { return this.desktopFacade.stop(); }
  async cleanup(): Promise<void> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = this.disposeOwnedAdapters();
    }
    return this.cleanupPromise;
  }

  private async disposeOwnedAdapters(): Promise<void> {
    if (!this.ownsAdapters) return;

    await Promise.all(
      [...new Set(this.adapters.values())].map(async (adapter) => {
        try {
          await adapter.dispose?.();
        } catch (error) {
          console.error(
            `Failed to dispose '${sanitizeErrorMessage(adapter.platform)}' adapter:`,
            sanitizeErrorMessage(error),
          );
        }
      }),
    );
  }
  getBrowserAdapter(): BrowserAdapterLike { return this.desktopFacade.getBrowser(); }
  getDesktopClient(): DesktopClientLike { return this.desktopFacade.getClient(); }
  isDesktopRunning(): boolean { return this.desktopFacade.isRunning(); }

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

  async tap(
    x: number,
    y: number,
    platform?: Platform,
    targetPid?: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inputProxy.tap(x, y, platform, targetPid, deviceId, signal);
  }

  async doubleTap(
    x: number,
    y: number,
    intervalMs: number = 100,
    platform?: Platform,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inputProxy.doubleTap(x, y, intervalMs, platform, deviceId, signal);
  }

  async longPress(
    x: number,
    y: number,
    durationMs: number = 1000,
    platform?: Platform,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inputProxy.longPress(x, y, durationMs, platform, deviceId, signal);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number = 300,
    platform?: Platform,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inputProxy.swipe(x1, y1, x2, y2, durationMs, platform, deviceId, signal);
  }

  async swipeDirection(
    direction: "up" | "down" | "left" | "right",
    platform?: Platform,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inputProxy.swipeDirection(direction, platform, deviceId, signal);
  }

  async inputText(
    text: string,
    platform?: Platform,
    targetPid?: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inputProxy.inputText(text, platform, targetPid, deviceId, signal);
  }

  async pressKey(
    key: string,
    platform?: Platform,
    targetPid?: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inputProxy.pressKey(key, platform, targetPid, deviceId, signal);
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

  async listApps(platform?: Platform, deviceId?: string): Promise<string[]> {
    return this.appProxy.listApps(platform, deviceId);
  }

  async uninstallApp(
    packageOrBundleId: string,
    platform?: Platform,
    deviceId?: string,
  ): Promise<string> {
    return this.appProxy.uninstallApp(packageOrBundleId, platform, deviceId);
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

  // ============ File transfer ops (proxy) ============

  async pushFile(
    localPath: string,
    remotePath: string,
    platform?: Platform,
    deviceId?: string,
  ): Promise<string> {
    return this.fileTransferProxy.pushFile(localPath, remotePath, platform, deviceId);
  }

  async pullFile(
    remotePath: string,
    localPath?: string,
    platform?: Platform,
    deviceId?: string,
  ): Promise<string> {
    return this.fileTransferProxy.pullFile(remotePath, localPath, platform, deviceId);
  }

  // ============ Raw client accessors (legacy — prefer getAdapter + capability guards) ============

  /** @deprecated Use `getAdapter("android", deviceId)` + capability type guards from `adapters/platform-adapter.ts`. */
  getAndroidClient(deviceId?: string): AdbClientLike {
    const adapter = this.adapters.get("android") as { getClient?: (deviceId?: string) => AdbClientLike } | undefined;
    if (!adapter || typeof adapter.getClient !== "function") {
      throw new Error("Android is not installed. Run `mcp-devices install android`.");
    }
    return adapter.getClient(deviceId);
  }

  /** @deprecated Use `getAdapter("ios", deviceId)` + capability type guards. */
  getIosClient(deviceId?: string): IosClientLike {
    const adapter = this.adapters.get("ios") as { getClient?: (deviceId?: string) => IosClientLike } | undefined;
    if (!adapter || typeof adapter.getClient !== "function") {
      throw new Error("iOS is not installed. Run `mcp-devices install ios`.");
    }
    return adapter.getClient(deviceId);
  }

  /**
   * @deprecated Use `getAdapter("aurora")` + capability type guards.
   *
   * Aurora ships as the separate `@mcp-devices/plugin-aurora` package
   * (4.0.0 physical split), so this resolves the client structurally via the
   * adapter's `getClient()` rather than an `instanceof` on a bundled class.
   */
  getAuroraClient(): AuroraClientLike {
    const adapter = this.adapters.get("aurora") as
      | { getClient?: () => AuroraClientLike }
      | undefined;
    if (!adapter || typeof adapter.getClient !== "function") {
      throw new Error(
        "Aurora is not installed. Run `mcp-devices install aurora`."
      );
    }
    return adapter.getClient();
  }

  getWebViewInspector(deviceId?: string): WebViewInspectorLike {
    const adapter = this.adapters.get("android") as
      | { getWebViewInspector?: (deviceId?: string) => WebViewInspectorLike }
      | undefined;
    if (!adapter || typeof adapter.getWebViewInspector !== "function") {
      throw new Error("Android is not installed. Run `mcp-devices install android`.");
    }
    return adapter.getWebViewInspector(deviceId);
  }
}


