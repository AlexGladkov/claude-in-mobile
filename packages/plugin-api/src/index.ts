/**
 * @mcp-devices/plugin-api
 *
 * Public plugin contract for the mcp-devices microkernel.
 *
 * Versioned independently of the product. See docs/adr/0002-plugin-api-v1.md
 * for the formal contract, lifecycle FSM, and event bus topics.
 */

export const PLUGIN_API_VERSION = "1" as const;
export type PluginApiVersion = typeof PLUGIN_API_VERSION;

export type Capability =
  | "screen"
  | "input"
  | "ui"
  | "shell"
  | "appLifecycle"
  | "permissions"
  | "logs"
  | "url"
  | "terminal"
  | "fileTransfer"
  | "deviceMgmt"
  // Marker capability for plugins that provide cross-platform meta tools
  // (a UX surface that fans out to platform adapters). Not a platform
  // capability — `findByCapability("screen")` should not return such
  // plugins.
  | "meta-tools";
export const ALL_CAPABILITIES: readonly Capability[] = [
  "screen",
  "input",
  "ui",
  "shell",
  "appLifecycle",
  "permissions",
  "logs",
  "url",
  "terminal",
  "fileTransfer",
  "deviceMgmt",
  "meta-tools",
] as const;

export type PluginPermission =
  | "device:read"
  | "device:write"
  | "filesystem:read"
  | "filesystem:write"
  | "network"
  | "subprocess"
  | "credentials:read";

export const ALL_PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  "device:read",
  "device:write",
  "filesystem:read",
  "filesystem:write",
  "network",
  "subprocess",
  "credentials:read",
] as const;

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: PluginApiVersion;
  readonly capabilities: readonly Capability[];
  /** Declared privileges checked against explicit host grants before load; not a runtime sandbox. */
  readonly permissions?: readonly PluginPermission[];
  readonly tools?: readonly string[];
  readonly description?: string;
  readonly homepage?: string;
}

/** Platform-neutral device record returned by discovery operations. */
export interface PlatformDevice {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly state: string;
  readonly isSimulator: boolean;
}

/** Platform-neutral screenshot compression options. */
export interface PlatformCompressOptions {
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly quality?: number;
  readonly maxSizeBytes?: number;
  readonly turbo?: boolean;
  readonly monitorIndex?: number;
}

/**
 * Platform-neutral bounds for a normalized UI element.
 *
 * Coordinates are expressed in the platform's screen coordinate space. The
 * host converts these records to its internal element representation before
 * running generic UI tools.
 */
export interface PluginUiElementBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Normalized UI element record returned by external platform plugins.
 *
 * All fields except the commonly useful identity/content fields are optional
 * so a provider can expose the vocabulary available from its accessibility
 * API without fabricating Android-only attributes.
 */
export interface PluginUiElement {
  readonly index?: number;
  readonly id?: string;
  readonly resourceId?: string;
  readonly role?: string;
  readonly className?: string;
  readonly packageName?: string;
  readonly text?: string;
  readonly label?: string;
  readonly contentDesc?: string;
  readonly value?: string;
  readonly enabled?: boolean;
  readonly visible?: boolean;
  readonly checkable?: boolean;
  readonly checked?: boolean;
  readonly clickable?: boolean;
  readonly focusable?: boolean;
  readonly focused?: boolean;
  readonly scrollable?: boolean;
  readonly longClickable?: boolean;
  readonly password?: boolean;
  readonly selected?: boolean;
  readonly bounds?: PluginUiElementBounds;
  readonly centerX?: number;
  readonly centerY?: number;
  readonly children?: readonly PluginUiElement[];
}

/** Provider contract for normalized UI records from an external platform. */
export interface PluginUiProvider {
  getUiElements(
    deviceId?: string,
  ): Promise<readonly PluginUiElement[]> | readonly PluginUiElement[];
}
/** Descriptive aliases for consumers that call this the platform UI layer. */
export type PluginUiElementProvider = PluginUiProvider;
export type PlatformUiElement = PluginUiElement;
export type PlatformUiProvider = PluginUiProvider;

/** UI capability contract. Built-in adapters retain the legacy raw hierarchy; external providers may expose normalized records instead. */
export interface PluginUiAdapter {
  /**
   * Legacy raw hierarchy operation. It is required for built-in platform
   * adapters, but optional for external adapters that provide normalized
   * records through getUiElements().
   */
  getUiHierarchy?: (deviceId?: string, turbo?: boolean) => Promise<string>;
  /**
   * Preferred provider for external platforms. Built-in platforms may omit
   * this and continue using their platform-specific hierarchy parsers.
   */
  getUiElements?: PluginUiProvider["getUiElements"];
}

/** Device discovery and selection capability. */
export interface PluginDeviceManagementAdapter {
  listDevices(): PlatformDevice[];
  selectDevice(deviceId: string): void;
  getSelectedDeviceId(): string | undefined;
  autoDetectDevice(): PlatformDevice | undefined;
}

/** Pointer, gesture, text, and key input capability. */
export interface PluginInputAdapter {
  /**
   * The optional signal is appended to preserve existing plugin call sites.
   * Adapters that can cancel an in-flight dispatch should honor it. Adapters
   * that cannot stop dispatched work must still avoid starting work when the
   * signal is already aborted; cancellation is otherwise best effort.
   */
  tap(
    x: number,
    y: number,
    targetPid?: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  doubleTap(
    x: number,
    y: number,
    intervalMs?: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  longPress(
    x: number,
    y: number,
    durationMs?: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  swipeDirection(
    direction: "up" | "down" | "left" | "right",
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  inputText(
    text: string,
    targetPid?: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  pressKey(
    key: string,
    targetPid?: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** Screenshot capture capability. */
export interface PluginScreenAdapter {
  screenshotAsync(
    compress: boolean,
    options?: PlatformCompressOptions,
    deviceId?: string,
  ): Promise<{ data: string; mimeType: string }>;
  getScreenshotBufferAsync(deviceId?: string): Promise<Buffer>;
}

/** System information capability used by generic system info tools. */
export interface PluginSystemAdapter {
  getSystemInfo(deviceId?: string): Promise<string>;
}

/** Shell command capability, intentionally separate from logs. */
export interface PluginShellAdapter {
  shell(command: string, deviceId?: string): string;
}

/** Log retrieval/clearing capability, intentionally separate from shell. */
export interface PluginLogsAdapter {
  getLogs(
    options: {
      level?: string;
      tag?: string;
      lines?: number;
      package?: string;
    },
    deviceId?: string,
  ): string;
  clearLogs(deviceId?: string): string;
}

/** Application launch/install/stop capability. */
export interface PluginAppLifecycleAdapter {
  launchApp(packageOrBundleId: string, deviceId?: string): string | Promise<string>;
  stopApp(packageOrBundleId: string, deviceId?: string): void;
  installApp(path: string, deviceId?: string): string;
}

/** Optional application inventory operations under appLifecycle. */
export interface PluginAppInventoryAdapter {
  listApps(deviceId?: string): string[] | Promise<string[]>;
  uninstallApp(packageOrBundleId: string, deviceId?: string): string | Promise<string>;
}

/** Runtime permission management capability. */
export interface PluginPermissionsAdapter {
  grantPermission(
    packageOrBundleId: string,
    permission: string,
    deviceId?: string,
  ): string;
  revokePermission(
    packageOrBundleId: string,
    permission: string,
    deviceId?: string,
  ): string;
  resetPermissions(packageOrBundleId: string, deviceId?: string): string;
}

/** File push/pull capability. */
export interface PluginFileTransferAdapter {
  pushFile(
    localPath: string,
    remotePath: string,
    deviceId?: string,
  ): string | Promise<string>;
  pullFile(
    remotePath: string,
    localPath?: string,
    deviceId?: string,
  ): string | Promise<string>;
}

/** URL-opening capability for platforms with native URL dispatch. */
export interface PluginUrlAdapter {
  openUrl(url: string, deviceId?: string): string | void | Promise<string | void>;
}


/**
 * Stable public adapter contract for plugins that expose a device platform.
 *
 * The core platform methods are grouped by the screen, input, UI, and device
 * management capabilities. Additional capabilities remain optional on this
 * structural type and are selected from the manifest by the kernel.
 */
export interface PluginPlatformAdapter
  extends
    PluginDeviceManagementAdapter,
    PluginInputAdapter,
    PluginScreenAdapter,
    PluginUiAdapter,
    PluginSystemAdapter {
  /** Public platform identifier served by this adapter. */
  readonly platform: string;

  // Capability-specific methods are optional on the public structural view;
  // the manifest determines which of them the host may route.
  readonly shell?: PluginShellAdapter["shell"];
  readonly getLogs?: PluginLogsAdapter["getLogs"];
  readonly clearLogs?: PluginLogsAdapter["clearLogs"];
  readonly launchApp?: PluginAppLifecycleAdapter["launchApp"];
  readonly stopApp?: PluginAppLifecycleAdapter["stopApp"];
  readonly installApp?: PluginAppLifecycleAdapter["installApp"];
  readonly listApps?: PluginAppInventoryAdapter["listApps"];
  readonly uninstallApp?: PluginAppInventoryAdapter["uninstallApp"];
  readonly grantPermission?: PluginPermissionsAdapter["grantPermission"];
  readonly revokePermission?: PluginPermissionsAdapter["revokePermission"];
  readonly resetPermissions?: PluginPermissionsAdapter["resetPermissions"];
  readonly pushFile?: PluginFileTransferAdapter["pushFile"];
  readonly pullFile?: PluginFileTransferAdapter["pullFile"];
  readonly openUrl?: PluginUrlAdapter["openUrl"];
  /** Release long-lived resources owned by this adapter. */
  readonly dispose?: () => void | Promise<void>;
}

/** Backward-compatible short aliases for public adapter records. */
export type PlatformAdapter = PluginPlatformAdapter;
export type PluginPlatformDevice = PlatformDevice;
export type PluginDevice = PlatformDevice;
export type PluginAppManagementAdapter = PluginAppLifecycleAdapter;
export type PluginPermissionAdapter = PluginPermissionsAdapter;

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface EventBus {
  emit<T extends keyof CoreTopics>(topic: T, payload: CoreTopics[T]): void;
  on<T extends keyof CoreTopics>(
    topic: T,
    handler: (payload: CoreTopics[T]) => void
  ): Unsubscribe;
}

export type Unsubscribe = () => void;

export interface CoreTopics {
  "plugin.registered": { pluginId: string };
  "plugin.initialized": { pluginId: string };
  "plugin.failed": { pluginId: string; error: string };
  "plugin.disposed": { pluginId: string };
  "session.spawned": { pluginId: string; sessionId: string };
  "session.died": {
    pluginId: string;
    sessionId: string;
    exitCode?: number;
  };
  "device.connected": { pluginId: string; deviceId: string };
  "device.disconnected": { pluginId: string; deviceId: string };
  "tool.invoked": { tool: string; args: unknown };
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  handler(args: unknown): Promise<unknown>;
}

export interface PluginContext {
  readonly logger: Logger;
  readonly config: Readonly<Record<string, unknown>>;
  readonly eventBus: EventBus;
  /** Aborted when plugin initialization times out or disposal begins. */
  readonly signal?: AbortSignal;
  registerTool(def: ToolDefinition): void;
}

export type PluginState =
  | "unregistered"
  | "registered"
  | "initializing"
  | "active"
  | "disposing"
  | "disposed"
  | "failed";

export interface SourcePlugin {
  readonly manifest: PluginManifest;
  readonly adapter?: PluginPlatformAdapter;
  init(ctx: PluginContext): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export class PluginContractError extends Error {
  constructor(
    message: string,
    public readonly pluginId: string
  ) {
    super(`[plugin:${pluginId}] ${message}`);
    this.name = "PluginContractError";
  }
}

export class CapabilityMissingError extends PluginContractError {
  constructor(pluginId: string, capability: Capability) {
    super(`missing required capability: ${capability}`, pluginId);
    this.name = "CapabilityMissingError";
  }
}

export class ApiVersionMismatchError extends PluginContractError {
  constructor(pluginId: string, requested: string, supported: PluginApiVersion) {
    super(
      `plugin requests apiVersion="${requested}" but kernel supports "${supported}"`,
      pluginId
    );
    this.name = "ApiVersionMismatchError";
  }
}

export function isCapability(value: unknown): value is Capability {
  return (
    typeof value === "string" &&
    (ALL_CAPABILITIES as readonly string[]).includes(value)
  );
}

export function isPluginPermission(value: unknown): value is PluginPermission {
  return (
    typeof value === "string" &&
    (ALL_PLUGIN_PERMISSIONS as readonly string[]).includes(value)
  );
}


export function hasCapability(
  manifest: PluginManifest,
  cap: Capability
): boolean {
  return manifest.capabilities.includes(cap);
}
