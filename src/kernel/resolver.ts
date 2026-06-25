import type { Capability, SourcePlugin } from "@mcp-devices/plugin-api";
import { CapabilityMissingError } from "@mcp-devices/plugin-api";
import type { PluginRegistry } from "./registry.js";

export interface ResolveQuery {
  capabilities: readonly Capability[];
  pluginId?: string;
}

export class CapabilityResolver {
  private cache = new Map<string, readonly SourcePlugin[]>();

  constructor(private readonly registry: PluginRegistry) {}

  resolve(query: ResolveQuery): readonly SourcePlugin[] {
    const key = JSON.stringify(query);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const matches = this.registry
      .list()
      .filter((e) => e.state === "active" || e.state === "registered")
      .map((e) => e.plugin)
      .filter((p) => {
        if (query.pluginId && p.manifest.id !== query.pluginId) return false;
        return query.capabilities.every((c) =>
          p.manifest.capabilities.includes(c)
        );
      });
    this.cache.set(key, matches);
    return matches;
  }

  resolveOne(query: ResolveQuery): SourcePlugin {
    const matches = this.resolve(query);
    if (matches.length === 0) {
      const target = query.pluginId ?? "<any>";
      throw new CapabilityMissingError(target, query.capabilities[0]!);
    }
    return matches[0]!;
  }

  invalidate(): void {
    this.cache.clear();
  }
}
