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
 *   ShellAdapter          -- shell only
 *   LogsAdapter           -- getLogs / clearLogs
 * Each concrete adapter implements only the interfaces it actually supports.
 * Consumers use type guards (`hasAppManagement`, `hasPermissions`, etc.)
 * to narrow before calling capability-specific methods.
 *
 * The legacy `PlatformAdapter` type alias is preserved for backward
 * compatibility -- it is the intersection of all capability interfaces.
 */

import {
  isCapability,
} from "@mcp-devices/plugin-api";
import type {
  Capability,
  PluginAppInventoryAdapter,
  PluginAppLifecycleAdapter,
  PluginDeviceManagementAdapter,
  PluginFileTransferAdapter,
  PluginInputAdapter,
  PluginLogsAdapter,
  PluginPermissionsAdapter,
  PluginPlatformAdapter,
  PluginScreenAdapter,
  PluginShellAdapter,
  PluginUiAdapter,
  PluginUrlAdapter,
} from "@mcp-devices/plugin-api";
import type { Platform, Device } from "../device-manager.js";
import type { CompressOptions } from "../utils/image.js";
// ============ Core -- every adapter MUST implement ============

export interface CorePlatformAdapter
  extends
    PluginPlatformAdapter,
    PluginDeviceManagementAdapter,
    PluginInputAdapter,
    PluginScreenAdapter,
    PluginUiAdapter {
  /** Which platform this adapter serves. */
  readonly platform: Platform;

  // The host's Device record refines the public PlatformDevice record.
  listDevices(): Device[];
  autoDetectDevice(): Device | undefined;

  screenshotAsync(
    compress: boolean,
    options?: CompressOptions & { monitorIndex?: number },
    deviceId?: string,
  ): Promise<{ data: string; mimeType: string }>;
}

// ============ Manifest capability contracts ============

/**
 * These aliases intentionally point at the public plugin-api contracts.
 * Keep host-only names for existing imports, but do not duplicate method
 * declarations here: the manifest and public SDK are the source of truth.
 */
export type AppManagementAdapter = PluginAppLifecycleAdapter;
export type AppInventoryAdapter = PluginAppInventoryAdapter;
export type PermissionAdapter = PluginPermissionsAdapter;
export type ShellAdapter = PluginShellAdapter;
export type LogsAdapter = PluginLogsAdapter;
export type FileTransferAdapter = PluginFileTransferAdapter;
export type UrlOpeningAdapter = PluginUrlAdapter;


// ============ Legacy sync screenshot (Android / iOS / Aurora only) ============

export interface SyncScreenshotAdapter {
  screenshotRaw(): string;
}
// ============ Performance trace capability ============

export type PerformanceTracePreset = "ui-jank" | "startup";
export type PerformanceTraceFormat = "chrome-json" | "perfetto-proto" | "xctrace-zip";

export interface PerformanceTraceStartOptions {
  preset: PerformanceTracePreset;
  durationMs: number;
  packageName?: string;
  bundleId?: string;
  session?: string;
  deviceId?: string;
}

export interface PerformanceTraceHandle {
  traceId: string;
  platform: Platform;
  preset: PerformanceTracePreset;
  startedAt: string;
  deadlineAt: string;
}

export interface PerformanceTraceFrameStats {
  totalFrames: number;
  jankyFrames: number;
  jankyPercent: number;
  p50Ms?: number;
  p90Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
}

export interface PerformanceTraceSummary {
  eventCount?: number;
  longTaskCount?: number;
  longestTaskMs?: number;
  totalLongTaskMs?: number;
  layoutCount?: number;
  paintCount?: number;
  scriptCount?: number;
  navigationCount?: number;
  frameStats?: PerformanceTraceFrameStats;
  sliceCount?: number;
  schedSliceCount?: number;
  cpuTimeMs?: number;
  jankSliceCount?: number;
  sampleCount?: number;
  instrumentCount?: number;
  analysisTool?: string;
  warnings: string[];
}

export interface PerformanceTraceCapture extends PerformanceTraceHandle {
  endedAt: string;
  durationMs: number;
  format: PerformanceTraceFormat;
  mimeType: string;
  producer: string;
  packageName?: string;
  session?: string;
  summary: PerformanceTraceSummary;
  data: Uint8Array;
}

export interface PerformanceTraceAdapter {
  startPerformanceTrace(options: PerformanceTraceStartOptions): Promise<PerformanceTraceHandle>;
  stopPerformanceTrace(traceId: string): Promise<PerformanceTraceCapture>;
}

export type HeapSnapshotFormat = "android-hprof" | "chrome-heapsnapshot" | "xctrace-allocations";

export interface HeapSnapshotOptions {
  outputPath: string;
  packageName?: string;
  bundleId?: string;
  session?: string;
  deviceId?: string;
}

export interface HeapSnapshotSummary {
  sizeBytes: number;
  nodeCount?: number;
  edgeCount?: number;
  traceFunctionCount?: number;
  totalPssMb?: number;
  nativeHeapMb?: number;
  dalvikHeapMb?: number;
  instrumentCount?: number;
  warnings: string[];
}

export interface HeapSnapshotCapture {
  platform: Platform;
  capturedAt: string;
  format: HeapSnapshotFormat;
  mimeType: string;
  producer: string;
  packageName?: string;
  session?: string;
  summary: HeapSnapshotSummary;
}

export interface HeapSnapshotAdapter {
  readonly heapSnapshotFormat: HeapSnapshotFormat;
  captureHeapSnapshot(options: HeapSnapshotOptions): Promise<HeapSnapshotCapture>;
}



// ============ Capability-aware type guards ============

/**
 * Kernel discovery records manifest capabilities here without mutating the
 * plugin-owned adapter object. The weak map also preserves adapter identity
 * for callers that retain a reference to the public implementation.
 */
const adapterCapabilities = new WeakMap<object, ReadonlySet<Capability>>();

export function setAdapterCapabilities(
  adapter: object,
  capabilities: readonly Capability[],
): void {
  adapterCapabilities.set(adapter, new Set(capabilities));
}

export function getAdapterCapabilities(
  adapter: object,
): readonly Capability[] | undefined {
  const registered = adapterCapabilities.get(adapter);
  if (registered) return [...registered];
  return readAdvertisedCapabilities(adapter);
}

function readAdvertisedCapabilities(
  adapter: object,
): readonly Capability[] | undefined {
  if (!("capabilities" in adapter)) return undefined;
  const advertised = adapter.capabilities;
  if (!Array.isArray(advertised)) return undefined;
  const capabilities: Capability[] = [];
  for (const capability of advertised) {
    if (isCapability(capability)) capabilities.push(capability);
  }
  return capabilities;
}

function hasDeclaredCapability(adapter: object, capability: Capability): boolean {
  const registered = adapterCapabilities.get(adapter);
  if (registered) return registered.has(capability);

  const advertised = readAdvertisedCapabilities(adapter);
  if (advertised === undefined) return true;
  return advertised.includes(capability);
}

function hasMethods(adapter: object, methods: readonly string[]): boolean {
  return methods.every((method) => typeof Reflect.get(adapter, method) === "function");
}

export function hasDeviceManagement(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & PluginDeviceManagementAdapter {
  return hasDeclaredCapability(adapter, "deviceMgmt")
    && hasMethods(adapter, [
      "listDevices",
      "selectDevice",
      "getSelectedDeviceId",
      "autoDetectDevice",
    ]);
}

export function hasInput(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & PluginInputAdapter {
  return hasDeclaredCapability(adapter, "input")
    && hasMethods(adapter, [
      "tap",
      "doubleTap",
      "longPress",
      "swipe",
      "swipeDirection",
      "inputText",
      "pressKey",
    ]);
}

export function hasScreen(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & PluginScreenAdapter {
  return hasDeclaredCapability(adapter, "screen")
    && hasMethods(adapter, ["screenshotAsync", "getScreenshotBufferAsync"]);
}

export function hasUi(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & PluginUiAdapter {
  return hasDeclaredCapability(adapter, "ui")
    && (
      typeof adapter.getUiElements === "function"
      || typeof adapter.getUiHierarchy === "function"
    );
}

/** Narrow a UI-capable adapter to the legacy raw hierarchy operation. */
export function hasRawUiHierarchy(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & {
  getUiHierarchy: NonNullable<PluginUiAdapter["getUiHierarchy"]>;
} {
  return hasUi(adapter) && typeof adapter.getUiHierarchy === "function";
}

export function hasAppManagement(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & AppManagementAdapter {
  return hasDeclaredCapability(adapter, "appLifecycle")
    && hasMethods(adapter, ["launchApp", "stopApp", "installApp"]);
}

export function hasAppInventory(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & AppInventoryAdapter {
  return hasDeclaredCapability(adapter, "appLifecycle")
    && hasMethods(adapter, ["listApps", "uninstallApp"]);
}

export function hasPermissions(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & PermissionAdapter {
  return hasDeclaredCapability(adapter, "permissions")
    && hasMethods(adapter, ["grantPermission", "revokePermission", "resetPermissions"]);
}

export function hasShell(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & ShellAdapter {
  return hasDeclaredCapability(adapter, "shell")
    && hasMethods(adapter, ["shell"]);
}

export function hasLogs(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & LogsAdapter {
  return hasDeclaredCapability(adapter, "logs")
    && hasMethods(adapter, ["getLogs", "clearLogs"]);
}

export function hasFileTransfer(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & FileTransferAdapter {
  return hasDeclaredCapability(adapter, "fileTransfer")
    && hasMethods(adapter, ["pushFile", "pullFile"]);
}

export function hasUrlOpening(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & UrlOpeningAdapter {
  return hasDeclaredCapability(adapter, "url")
    && hasMethods(adapter, ["openUrl"]);
}

export function hasSyncScreenshot(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & SyncScreenshotAdapter {
  return hasDeclaredCapability(adapter, "screen")
    && hasMethods(adapter, ["screenshotRaw"]);
}

export function hasPerformanceTrace(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & PerformanceTraceAdapter {
  return hasMethods(adapter, ["startPerformanceTrace", "stopPerformanceTrace"]);
}

export function hasHeapSnapshot(
  adapter: CorePlatformAdapter,
): adapter is CorePlatformAdapter & HeapSnapshotAdapter {
  const format = Reflect.get(adapter, "heapSnapshotFormat");
  return (
    (format === "android-hprof"
      || format === "chrome-heapsnapshot"
      || format === "xctrace-allocations")
    && hasMethods(adapter, ["captureHeapSnapshot"])
  );
}


// ============ Capability requirement helpers ============

export class CapabilityNotSupportedError extends Error {
  constructor(public readonly platform: Platform, public readonly capability: string) {
    super(`Capability '${capability}' is not supported on platform '${platform}'.`);
    this.name = "CapabilityNotSupportedError";
  }
}

export function requireAppManagement(
  adapter: CorePlatformAdapter,
): CorePlatformAdapter & AppManagementAdapter {
  if (!hasAppManagement(adapter)) {
    throw new CapabilityNotSupportedError(adapter.platform, "AppManagement");
  }
  return adapter;
}

export function requireAppInventory(
  adapter: CorePlatformAdapter,
): CorePlatformAdapter & AppInventoryAdapter {
  if (!hasAppInventory(adapter)) {
    throw new CapabilityNotSupportedError(adapter.platform, "AppInventory");
  }
  return adapter;
}

export function requirePermissions(
  adapter: CorePlatformAdapter,
): CorePlatformAdapter & PermissionAdapter {
  if (!hasPermissions(adapter)) {
    throw new CapabilityNotSupportedError(adapter.platform, "Permissions");
  }
  return adapter;
}

export function requireShell(
  adapter: CorePlatformAdapter,
): CorePlatformAdapter & ShellAdapter {
  if (!hasShell(adapter)) {
    throw new CapabilityNotSupportedError(adapter.platform, "Shell");
  }
  return adapter;
}

export function requireFileTransfer(
  adapter: CorePlatformAdapter,
): CorePlatformAdapter & FileTransferAdapter {
  if (!hasFileTransfer(adapter)) {
    throw new CapabilityNotSupportedError(adapter.platform, "FileTransfer");
  }
  return adapter;
}

export function requireUrlOpening(
  adapter: CorePlatformAdapter,
): CorePlatformAdapter & UrlOpeningAdapter {
  if (!hasUrlOpening(adapter)) {
    throw new CapabilityNotSupportedError(adapter.platform, "UrlOpening");
  }
  return adapter;
}

export function requirePerformanceTrace(
  adapter: CorePlatformAdapter,
): CorePlatformAdapter & PerformanceTraceAdapter {
  if (!hasPerformanceTrace(adapter)) {
    throw new CapabilityNotSupportedError(adapter.platform, "PerformanceTrace");
  }
  return adapter;
}

export function requireHeapSnapshot(
  adapter: CorePlatformAdapter,
): CorePlatformAdapter & HeapSnapshotAdapter {
  if (!hasHeapSnapshot(adapter)) {
    throw new CapabilityNotSupportedError(adapter.platform, "HeapSnapshot");
  }
  return adapter;
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
  { getUiHierarchy: NonNullable<PluginUiAdapter["getUiHierarchy"]> } &
  AppManagementAdapter &
  AppInventoryAdapter &
  PermissionAdapter &
  ShellAdapter &
  LogsAdapter &
  FileTransferAdapter &
  UrlOpeningAdapter &
  SyncScreenshotAdapter;
