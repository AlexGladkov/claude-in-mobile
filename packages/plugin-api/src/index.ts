/**
 * @claude-in-mobile/plugin-api
 *
 * Public plugin contract for the claude-in-mobile microkernel.
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
  | "terminal"
  | "fileTransfer"
  | "deviceMgmt";

export const ALL_CAPABILITIES: readonly Capability[] = [
  "screen",
  "input",
  "ui",
  "shell",
  "appLifecycle",
  "permissions",
  "logs",
  "terminal",
  "fileTransfer",
  "deviceMgmt",
] as const;

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: PluginApiVersion;
  readonly capabilities: readonly Capability[];
  readonly tools?: readonly string[];
  readonly description?: string;
  readonly homepage?: string;
}

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

export function hasCapability(
  manifest: PluginManifest,
  cap: Capability
): boolean {
  return manifest.capabilities.includes(cap);
}
