import {
  ApiVersionMismatchError,
  PLUGIN_API_VERSION,
  PluginContractError,
  isCapability,
  isPluginPermission,
} from "@mcp-devices/plugin-api";
import type {
  Capability,
  PluginManifest,
  PluginPermission,
  PluginState,
  SourcePlugin,
} from "@mcp-devices/plugin-api";

export interface RegistryEntry {
  readonly plugin: SourcePlugin;
  state: PluginState;
  lastError?: string;
}

export interface PluginRegistry {
  register(plugin: SourcePlugin): void;
  get(id: string): RegistryEntry | undefined;
  list(): readonly RegistryEntry[];
  findByCapability(cap: Capability): readonly RegistryEntry[];
  freeze(): void;
  isFrozen(): boolean;
}

const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]+$/u;

export function validateManifest(value: unknown): asserts value is PluginManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginContractError("manifest must be an object", "<invalid>");
  }
  const manifest = value as Record<string, unknown>;
  const id = manifest.id;
  if (
    typeof id !== "string"
    || id.length === 0
    || id.length > 128
    || !/^[a-z0-9][a-z0-9._-]*$/u.test(id)
  ) {
    throw new PluginContractError(
      "manifest.id must match /^[a-z0-9][a-z0-9._-]*$/ and be at most 128 characters",
      typeof id === "string" ? id : "<invalid>",
    );
  }
  if (
    typeof manifest.name !== "string"
    || manifest.name.length === 0
    || manifest.name.length > 256
    || !SAFE_TEXT_RE.test(manifest.name)
  ) {
    throw new PluginContractError("manifest.name must be a bounded non-empty string", id);
  }
  if (
    typeof manifest.version !== "string"
    || manifest.version.length === 0
    || manifest.version.length > 128
    || !SAFE_TEXT_RE.test(manifest.version)
  ) {
    throw new PluginContractError("manifest.version must be a bounded non-empty string", id);
  }
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new ApiVersionMismatchError(id, String(manifest.apiVersion), PLUGIN_API_VERSION);
  }
  if (
    !Array.isArray(manifest.capabilities)
    || manifest.capabilities.length === 0
    || manifest.capabilities.length > 32
  ) {
    throw new PluginContractError("manifest.capabilities must be a bounded non-empty array", id);
  }
  const seen = new Set<Capability>();
  for (const capability of manifest.capabilities) {
    if (!isCapability(capability)) {
      throw new PluginContractError("manifest contains an unknown capability", id);
    }
    if (seen.has(capability)) {
      throw new PluginContractError(`duplicate capability: ${capability}`, id);
    }
    seen.add(capability);
  }
  if (
    manifest.permissions !== undefined
    && (
      !Array.isArray(manifest.permissions)
      || manifest.permissions.length > 32
      || manifest.permissions.some((permission) => !isPluginPermission(permission))
    )
  ) {
    throw new PluginContractError("manifest.permissions is invalid", id);
  }
  if (Array.isArray(manifest.permissions)) {
    const permissions = new Set<PluginPermission>();
    for (const permission of manifest.permissions) {
      if (permissions.has(permission)) {
        throw new PluginContractError(`duplicate permission: ${permission}`, id);
      }
      permissions.add(permission);
    }
  }
  if (
    manifest.tools !== undefined
    && (
      !Array.isArray(manifest.tools)
      || manifest.tools.length > 1000
      || manifest.tools.some(
        (tool) => typeof tool !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(tool),
      )
    )
  ) {
    throw new PluginContractError("manifest.tools is invalid", id);
  }
  for (const [field, limit] of [["description", 2048], ["homepage", 2048]] as const) {
    const valueForField = manifest[field];
    if (
      valueForField !== undefined
      && (
        typeof valueForField !== "string"
        || valueForField.length === 0
        || valueForField.length > limit
        || !SAFE_TEXT_RE.test(valueForField)
      )
    ) {
      throw new PluginContractError(`manifest.${field} is invalid`, id);
    }
  }
}

export const validatePluginManifest = validateManifest;

export function validateSourcePlugin(value: unknown): asserts value is SourcePlugin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginContractError("plugin must be an object", "<invalid>");
  }
  const plugin = value as Record<string, unknown>;
  validateManifest(plugin.manifest);
  if (typeof plugin.init !== "function") {
    throw new PluginContractError("plugin.init must be a function", plugin.manifest.id);
  }
  if (plugin.dispose !== undefined && typeof plugin.dispose !== "function") {
    throw new PluginContractError("plugin.dispose must be a function", plugin.manifest.id);
  }
  validatePluginAdapter(plugin.adapter, plugin.manifest.id, plugin.manifest.capabilities);
}

const ADAPTER_CAPABILITY_METHODS: Partial<Record<Capability, readonly string[]>> = {
  screen: ["screenshotAsync", "getScreenshotBufferAsync"],
  input: [
    "tap",
    "doubleTap",
    "longPress",
    "swipe",
    "swipeDirection",
    "inputText",
    "pressKey",
  ],
  shell: ["shell"],
  logs: ["getLogs", "clearLogs"],
  appLifecycle: ["launchApp", "stopApp", "installApp"],
  permissions: ["grantPermission", "revokePermission", "resetPermissions"],
  fileTransfer: ["pushFile", "pullFile"],
  url: ["openUrl"],
  deviceMgmt: [
    "listDevices",
    "selectDevice",
    "getSelectedDeviceId",
    "autoDetectDevice",
  ],
};

const BUILTIN_ADAPTER_PLATFORMS = [
  "android",
  "ios",
  "desktop",
  "aurora",
  "harmony",
  "browser",
] as const;

function validatePluginAdapter(
  value: unknown,
  pluginId: string,
  capabilities: readonly Capability[],
): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginContractError("plugin.adapter must be an object", pluginId);
  }
  const adapter = value as Record<string, unknown>;
  if (
    typeof adapter.platform !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(adapter.platform)
  ) {
    throw new PluginContractError("plugin.adapter.platform is invalid", pluginId);
  }

  const isBuiltinPlatform = BUILTIN_ADAPTER_PLATFORMS.some((id) => id === adapter.platform);
  const hasRawUiHierarchy = typeof adapter.getUiHierarchy === "function";
  const hasNormalizedUiProvider = typeof adapter.getUiElements === "function";
  const coreMethods = [
    "listDevices",
    "selectDevice",
    "getSelectedDeviceId",
    "autoDetectDevice",
    "tap",
    "doubleTap",
    "longPress",
    "swipe",
    "swipeDirection",
    "inputText",
    "pressKey",
    "screenshotAsync",
    "getScreenshotBufferAsync",
    "getSystemInfo",
  ] as const;
  for (const method of coreMethods) {
    if (typeof adapter[method] !== "function") {
      throw new PluginContractError(`plugin.adapter.${method} must be a function`, pluginId);
    }
  }

  const hasUiCapability = capabilities.includes("ui");
  if (hasUiCapability && isBuiltinPlatform && !hasRawUiHierarchy) {
    throw new PluginContractError(
      "plugin.adapter.getUiHierarchy must be a function for built-in ui platforms",
      pluginId,
    );
  }
  if (hasUiCapability && !isBuiltinPlatform && !hasNormalizedUiProvider) {
    throw new PluginContractError(
      "plugin.adapter.getUiElements must be a function for external ui platforms",
      pluginId,
    );
  }

  for (const capability of capabilities) {
    const required = ADAPTER_CAPABILITY_METHODS[capability];
    if (required) {
      for (const method of required) {
        if (typeof adapter[method] !== "function") {
          throw new PluginContractError(
            `plugin.adapter.${method} must be a function for capability '${capability}'`,
            pluginId,
          );
        }
      }
    }
  }

  if (adapter.dispose !== undefined && typeof adapter.dispose !== "function") {
    throw new PluginContractError("plugin.adapter.dispose must be a function", pluginId);
  }
}




export class InMemoryRegistry implements PluginRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private frozen = false;

  register(plugin: SourcePlugin): void {
    validateSourcePlugin(plugin);
    if (this.frozen) {
      throw new PluginContractError("registry is frozen", plugin.manifest.id);
    }
    if (this.entries.has(plugin.manifest.id)) {
      throw new PluginContractError("plugin id already registered", plugin.manifest.id);
    }
    this.entries.set(plugin.manifest.id, { plugin, state: "registered" });
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }

  list(): readonly RegistryEntry[] {
    return Array.from(this.entries.values());
  }

  findByCapability(cap: Capability): readonly RegistryEntry[] {
    return this.list().filter((e) => e.plugin.manifest.capabilities.includes(cap));
  }

  freeze(): void {
    this.frozen = true;
  }

  isFrozen(): boolean {
    return this.frozen;
  }
}
