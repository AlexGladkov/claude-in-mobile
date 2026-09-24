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

function validateManifest(value: unknown): asserts value is PluginManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginContractError("manifest must be an object", "<invalid>");
  }
  const manifest = value as Record<string, unknown>;
  const id = manifest.id;
  if (
    typeof id !== "string"
    || id.length === 0
    || id.length > 128
    || !/^[a-z0-9][a-z0-9._-]*$/.test(id)
  ) {
    throw new PluginContractError(
      "manifest.id must match /^[a-z0-9][a-z0-9._-]*$/ and be at most 128 characters",
      "<invalid>",
    );
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
        (tool) => typeof tool !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(tool),
      )
    )
  ) {
    throw new PluginContractError("manifest.tools is invalid", id);
  }
}

function validatePlugin(value: unknown): asserts value is SourcePlugin {
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
}

export class InMemoryRegistry implements PluginRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private frozen = false;

  register(plugin: SourcePlugin): void {
    validatePlugin(plugin);
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
