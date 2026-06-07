import type { SourcePlugin } from "@claude-in-mobile/plugin-api";
import type { PluginRegistry } from "./registry.js";

/**
 * Built-in plugin loader.
 *
 * For 3.11.0 the loader is intentionally simple: it accepts an explicit list of
 * built-in plugins and registers them in order. Runtime discovery from
 * filesystem (`~/.claude-in-mobile/plugins/`) and third-party loading are
 * deferred to a later release (see ADR 0001).
 */
export interface BuiltinLoaderDeps {
  registry: PluginRegistry;
}

export class BuiltinPluginLoader {
  constructor(private readonly deps: BuiltinLoaderDeps) {}

  load(plugins: readonly SourcePlugin[]): void {
    for (const p of plugins) {
      this.deps.registry.register(p);
    }
  }
}
