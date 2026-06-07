import {
  ApiVersionMismatchError,
  PLUGIN_API_VERSION,
  PluginContractError,
  type Capability,
  type PluginManifest,
  type PluginState,
  type SourcePlugin,
} from "@claude-in-mobile/plugin-api";

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

function validateManifest(manifest: PluginManifest): void {
  if (!manifest.id || typeof manifest.id !== "string") {
    throw new PluginContractError("manifest.id must be a non-empty string", String(manifest.id));
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id)) {
    throw new PluginContractError(
      `manifest.id must match /^[a-z0-9][a-z0-9._-]*$/`,
      manifest.id
    );
  }
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new ApiVersionMismatchError(manifest.id, String(manifest.apiVersion), PLUGIN_API_VERSION);
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    throw new PluginContractError("manifest.capabilities must be non-empty array", manifest.id);
  }
  const seen = new Set<string>();
  for (const c of manifest.capabilities) {
    if (seen.has(c)) {
      throw new PluginContractError(`duplicate capability: ${c}`, manifest.id);
    }
    seen.add(c);
  }
}

export class InMemoryRegistry implements PluginRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private frozen = false;

  register(plugin: SourcePlugin): void {
    if (this.frozen) {
      throw new PluginContractError("registry is frozen", plugin.manifest.id);
    }
    validateManifest(plugin.manifest);
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
