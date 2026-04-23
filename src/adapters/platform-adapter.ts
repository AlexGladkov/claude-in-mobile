/**
 * Platform adapter interfaces -- segregated by capability (ISP).
 *
 * Instead of a single monolithic PlatformAdapter that forces Browser and
 * Desktop to throw "not supported" for mobile-only features, the contract
 * is split into focused interfaces:
 *
 *   CorePlatformAdapter   -- universal: every platform implements this
 *   AppManagementAdapter  -- launchApp / stopApp / installApp
 *   PermissionAdapter     -- grant / revoke / reset permissions
 *   ShellAdapter          -- shell / logs / clearLogs
 *
 * Each concrete adapter implements only the interfaces it actually supports.
 * Consumers use type guards (`hasAppManagement`, `hasPermissions`, etc.)
 * to narrow before calling capability-specific methods.
 *
 * The legacy `PlatformAdapter` type alias is preserved for backward
 * compatibility -- it is the intersection of all capability interfaces.
 */

import type { Platform, Device } from "../device-manager.js";
import type { CompressOptions } from "../utils/image.js";

// ============ Core -- every adapter MUST implement ============

export interface CorePlatformAdapter {
  /** Which platform this adapter serves. */
  readonly platform: Platform;

  // -- Device management --
  listDevices(): Device[];
  selectDevice(deviceId: string): void;
  getSelectedDeviceId(): string | undefined;
  autoDetectDevice(): Device | undefined;

  // -- Core interaction --
  tap(x: number, y: number, targetPid?: number): Promise<void>;
  doubleTap(x: number, y: number, intervalMs?: number): Promise<void>;
  longPress(x: number, y: number, durationMs?: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void>;
  swipeDirection(direction: "up" | "down" | "left" | "right"): Promise<void>;
  inputText(text: string, targetPid?: number): Promise<void>;
  pressKey(key: string, targetPid?: number): Promise<void>;

  // -- Screenshot --
  screenshotAsync(
    compress: boolean,
    options?: CompressOptions & { monitorIndex?: number },
  ): Promise<{ data: string; mimeType: string }>;
  getScreenshotBufferAsync(): Promise<Buffer>;

  // -- UI --
  getUiHierarchy(): Promise<string>;

  // -- System info --
  getSystemInfo(): Promise<string>;
}

// ============ App management capability ============

export interface AppManagementAdapter {
  launchApp(packageOrBundleId: string): string;
  stopApp(packageOrBundleId: string): void;
  installApp(path: string): string;
}

// ============ Permission management capability ============

export interface PermissionAdapter {
  grantPermission(packageOrBundleId: string, permission: string): string;
  revokePermission(packageOrBundleId: string, permission: string): string;
  resetPermissions(packageOrBundleId: string): string;
}

// ============ Shell / logs capability ============

export interface ShellAdapter {
  shell(command: string): string;
  getLogs(options: {
    level?: string;
    tag?: string;
    lines?: number;
    package?: string;
  }): string;
  clearLogs(): string;
}

// ============ Legacy sync screenshot (Android / iOS / Aurora only) ============

export interface SyncScreenshotAdapter {
  screenshotRaw(): string;
}

// ============ Type guards ============

export function hasAppManagement(adapter: CorePlatformAdapter): adapter is CorePlatformAdapter & AppManagementAdapter {
  return (
    "launchApp" in adapter &&
    "stopApp" in adapter &&
    "installApp" in adapter
  );
}

export function hasPermissions(adapter: CorePlatformAdapter): adapter is CorePlatformAdapter & PermissionAdapter {
  return (
    "grantPermission" in adapter &&
    "revokePermission" in adapter &&
    "resetPermissions" in adapter
  );
}

export function hasShell(adapter: CorePlatformAdapter): adapter is CorePlatformAdapter & ShellAdapter {
  return (
    "shell" in adapter &&
    "getLogs" in adapter &&
    "clearLogs" in adapter
  );
}

export function hasSyncScreenshot(adapter: CorePlatformAdapter): adapter is CorePlatformAdapter & SyncScreenshotAdapter {
  return "screenshotRaw" in adapter;
}

// ============ Backward-compatible union ============

/**
 * Legacy full interface -- the intersection of ALL capabilities.
 *
 * Existing code that imports `PlatformAdapter` still compiles, but new
 * code should prefer `CorePlatformAdapter` and narrow with type guards.
 *
 * @deprecated Prefer `CorePlatformAdapter` with capability type guards.
 */
export type PlatformAdapter =
  CorePlatformAdapter &
  AppManagementAdapter &
  PermissionAdapter &
  ShellAdapter &
  SyncScreenshotAdapter;
