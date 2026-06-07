/**
 * Built-in plugin bootstrap.
 *
 * Creates the kernel (registry + event bus + lifecycle) and registers all
 * first-party plugins. This is the canonical entry point for the microkernel
 * runtime.
 *
 * Intentionally does NOT depend on DeviceManager — the legacy facade reads
 * adapters from the kernel via a static factory (see DeviceManager.fromKernel).
 */

import type { Logger, SourcePlugin, ToolDefinition } from "@claude-in-mobile/plugin-api";

import { InMemoryEventBus } from "../kernel/eventbus.js";
import { InMemoryRegistry, type PluginRegistry } from "../kernel/registry.js";
import { LifecycleOrchestrator } from "../kernel/lifecycle.js";
import { CapabilityResolver } from "../kernel/resolver.js";

import { createAndroidPlugin } from "../plugins/android/index.js";
import { createIosPlugin } from "../plugins/ios/index.js";
import { createDesktopPlugin } from "../plugins/desktop/index.js";
import { createWebPlugin } from "../plugins/web/index.js";
import { createAuroraPlugin } from "../plugins/aurora/index.js";
import { createReplPlugin } from "../plugins/repl/index.js";

export interface KernelHandle {
  readonly registry: PluginRegistry;
  readonly eventBus: InMemoryEventBus;
  readonly resolver: CapabilityResolver;
  readonly lifecycle: LifecycleOrchestrator;
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  initAll(): Promise<void>;
  disposeAll(): Promise<void>;
  getPlugin<T extends SourcePlugin = SourcePlugin>(id: string): T | undefined;
}

export interface BootstrapOptions {
  logger?: Logger;
  configFor?: (pluginId: string) => Record<string, unknown>;
  builtins?: ReadonlyArray<() => SourcePlugin>;
}

const DEFAULT_BUILTINS: ReadonlyArray<() => SourcePlugin> = [
  createAndroidPlugin,
  createIosPlugin,
  createDesktopPlugin,
  createWebPlugin,
  createAuroraPlugin,
  () => createReplPlugin(),
];

function consoleLogger(): Logger {
  // stderr-only: stdout is reserved for MCP JSON-RPC framing.
  return {
    debug: () => {},
    info: (m, meta) => console.error(`[info] ${m}`, meta ?? ""),
    warn: (m, meta) => console.error(`[warn] ${m}`, meta ?? ""),
    error: (m, meta) => console.error(`[error] ${m}`, meta ?? ""),
  };
}

export function bootstrapKernel(options: BootstrapOptions = {}): KernelHandle {
  const registry = new InMemoryRegistry();
  const eventBus = new InMemoryEventBus();
  const logger = options.logger ?? consoleLogger();
  const tools = new Map<string, ToolDefinition>();

  const lifecycle = new LifecycleOrchestrator({
    registry,
    eventBus,
    logger,
    configFor: options.configFor ?? (() => ({})),
    onToolRegistered: (_pluginId, def) => {
      tools.set(def.name, def);
    },
  });

  for (const factory of options.builtins ?? DEFAULT_BUILTINS) {
    registry.register(factory());
  }

  const resolver = new CapabilityResolver(registry);

  return {
    registry,
    eventBus,
    resolver,
    lifecycle,
    tools,
    async initAll() {
      await lifecycle.initAll();
      resolver.invalidate();
    },
    async disposeAll() {
      await lifecycle.disposeAll();
    },
    getPlugin<T extends SourcePlugin = SourcePlugin>(id: string): T | undefined {
      return registry.get(id)?.plugin as T | undefined;
    },
  };
}
