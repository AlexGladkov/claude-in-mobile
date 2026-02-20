/**
 * Platform adapter interface — the contract every platform must implement.
 *
 * Each adapter wraps a low-level client (AdbClient, IosClient, DesktopClient, AuroraClient)
 * and exposes a uniform API that DeviceManager delegates to.
 */

import type { Platform, Device } from "../device-manager.js";
import type { CompressOptions } from "../utils/image.js";

export interface PlatformAdapter {
  /** Which platform this adapter serves. */
  readonly platform: Platform;

  // ============ Device management ============

  /** List all devices available on this platform. */
  listDevices(): Device[];

  /** Set the active device by ID. */
  selectDevice(deviceId: string): void;

  /** Return the currently selected device ID, if any. */
  getSelectedDeviceId(): string | undefined;

  /**
   * Attempt to auto-detect a usable device.
   * Returns a Device if one can be found, undefined otherwise.
   * This is the FIX for bug #8: after server restart the deviceId is lost
   * and subsequent commands fail because no device is selected.
   */
  autoDetectDevice(): Device | undefined;

  // ============ Core actions ============

  tap(x: number, y: number, targetPid?: number): Promise<void>;
  doubleTap(x: number, y: number, intervalMs?: number): Promise<void>;
  longPress(x: number, y: number, durationMs?: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void>;
  swipeDirection(direction: "up" | "down" | "left" | "right"): Promise<void>;
  inputText(text: string, targetPid?: number): Promise<void>;
  pressKey(key: string, targetPid?: number): Promise<void>;

  // ============ Screenshot ============

  /**
   * Take a screenshot and return compressed result.
   * The adapter is responsible for delegating to its client appropriately.
   */
  screenshotAsync(
    compress: boolean,
    options?: CompressOptions & { monitorIndex?: number },
  ): Promise<{ data: string; mimeType: string }>;

  /**
   * Return raw screenshot as PNG Buffer (for annotation, diff etc.).
   * Throws if the platform does not support raw buffer extraction.
   */
  getScreenshotBufferAsync(): Promise<Buffer>;

  /**
   * Take screenshot and return base64 (legacy sync path).
   * Not all platforms support this; those that don't should throw.
   */
  screenshotRaw(): string;

  // ============ UI ============

  getUiHierarchy(): Promise<string>;

  // ============ App management ============

  launchApp(packageOrBundleId: string): string;
  stopApp(packageOrBundleId: string): void;
  installApp(path: string): string;

  // ============ Permissions ============

  grantPermission(packageOrBundleId: string, permission: string): string;
  revokePermission(packageOrBundleId: string, permission: string): string;
  resetPermissions(packageOrBundleId: string): string;

  // ============ System ============

  shell(command: string): string;

  getLogs(options: {
    level?: string;
    tag?: string;
    lines?: number;
    package?: string;
  }): string;

  clearLogs(): string;

  getSystemInfo(): Promise<string>;
}
