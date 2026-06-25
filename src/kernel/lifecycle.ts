import type {
  EventBus,
  Logger,
  PluginContext,
  ToolDefinition,
} from "@mcp-devices/plugin-api";
import type { PluginRegistry, RegistryEntry } from "./registry.js";

export const DEFAULT_INIT_TIMEOUT_MS = 10_000;
export const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;

export interface LifecycleDeps {
  registry: PluginRegistry;
  eventBus: EventBus;
  logger: Logger;
  configFor(pluginId: string): Record<string, unknown>;
  onToolRegistered(pluginId: string, def: ToolDefinition): void;
  initTimeoutMs?: number;
  disposeTimeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function buildContext(
  entry: RegistryEntry,
  deps: LifecycleDeps
): PluginContext {
  return {
    logger: deps.logger,
    config: Object.freeze(deps.configFor(entry.plugin.manifest.id) ?? {}),
    eventBus: deps.eventBus,
    registerTool(def: ToolDefinition) {
      deps.onToolRegistered(entry.plugin.manifest.id, def);
    },
  };
}

export class LifecycleOrchestrator {
  constructor(private readonly deps: LifecycleDeps) {}

  async initAll(): Promise<void> {
    for (const entry of this.deps.registry.list()) {
      await this.initOne(entry);
    }
  }

  async initOne(entry: RegistryEntry): Promise<void> {
    if (entry.state !== "registered") return;
    entry.state = "initializing";
    const ctx = buildContext(entry, this.deps);
    const timeout = this.deps.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    try {
      await withTimeout(
        Promise.resolve(entry.plugin.init(ctx)),
        timeout,
        `plugin "${entry.plugin.manifest.id}" init`
      );
      entry.state = "active";
      this.deps.eventBus.emit("plugin.initialized", {
        pluginId: entry.plugin.manifest.id,
      });
    } catch (err) {
      entry.state = "failed";
      entry.lastError = err instanceof Error ? err.message : String(err);
      this.deps.eventBus.emit("plugin.failed", {
        pluginId: entry.plugin.manifest.id,
        error: entry.lastError,
      });
      this.deps.logger.error("plugin init failed", {
        pluginId: entry.plugin.manifest.id,
        error: entry.lastError,
      });
    }
  }

  async disposeAll(): Promise<void> {
    for (const entry of this.deps.registry.list()) {
      await this.disposeOne(entry);
    }
  }

  async disposeOne(entry: RegistryEntry): Promise<void> {
    if (entry.state === "disposed" || entry.state === "unregistered") return;
    const id = entry.plugin.manifest.id;
    entry.state = "disposing";
    const dispose = entry.plugin.dispose;
    const timeout = this.deps.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS;
    try {
      if (dispose) {
        await withTimeout(
          Promise.resolve(dispose.call(entry.plugin)),
          timeout,
          `plugin "${id}" dispose`
        );
      }
    } catch (err) {
      this.deps.logger.warn("plugin dispose threw", {
        pluginId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      entry.state = "disposed";
      this.deps.eventBus.emit("plugin.disposed", { pluginId: id });
    }
  }
}
