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
import { ExternalPluginLoader } from "../kernel/external-loader.js";

import { createBuiltinToolsPlugin } from "../plugins/builtin-tools/index.js";
import { createReplPlugin } from "../plugins/repl/index.js";
import { resolveEnabledPlatforms, type PlatformId } from "./platform-config.js";

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
  /**
   * Discover third-party plugins from the filesystem.
   * - `true`  → scan `~/.claude-in-mobile/plugins/` (default off — opt-in for now)
   * - object  → forwarded to `ExternalPluginLoader` for custom roots/api versions
   */
  externalPlugins?: boolean | {
    additionalRoots?: ReadonlyArray<string>;
    supportedApiVersions?: ReadonlyArray<string>;
  };
  /**
   * Which platform plugins to load. When omitted, resolved from
   * `CLAUDE_IN_MOBILE_PLATFORMS` / `~/.claude-in-mobile/config.json` /
   * default (none). Ignored if `builtins` is supplied explicitly.
   */
  platforms?: ReadonlyArray<PlatformId>;
}

/**
 * Always-on base plugins. BuiltinToolsPlugin must run first so meta tools and
 * aliases are registered before any plugin consults the registry during init.
 * REPL is non-platform and always available. Platform plugins are added
 * on top, gated by the enabled set — base is slim by default.
 */
const BASE_BUILTINS: ReadonlyArray<() => SourcePlugin> = [
  createBuiltinToolsPlugin,
  () => createReplPlugin(),
];

/**
 * Platforms whose implementation still lives in this package (loaded
 * synchronously). As platforms are extracted into standalone
 * `@claude-in-mobile/plugin-*` packages (4.0.0 physical split), they move
 * from here to PACKAGED_PLATFORMS.
 */
const IN_BASE_FACTORIES: Partial<Record<PlatformId, () => SourcePlugin>> = {
};

/**
 * Platforms delivered as separate npm packages, loaded by dynamic import only
 * when enabled AND installed. A missing package degrades gracefully (the
 * platform is simply unavailable). The specifier is a variable so tsc does not
 * require the package as a build-time dependency.
 */
const PACKAGED_PLATFORMS: Partial<Record<PlatformId, string>> = {
  aurora: "@claude-in-mobile/plugin-aurora",
  web: "@claude-in-mobile/plugin-web",
  desktop: "@claude-in-mobile/plugin-desktop",
  android: "@claude-in-mobile/plugin-android",
  ios: "@claude-in-mobile/plugin-ios",
};

/** Base plugins + the enabled in-base platform plugins, in deterministic order. */
function defaultBuiltins(
  platforms?: ReadonlyArray<PlatformId>
): Array<() => SourcePlugin> {
  const enabled = platforms ?? resolveEnabledPlatforms();
  const inBase = enabled
    .map((p) => IN_BASE_FACTORIES[p])
    .filter((f): f is () => SourcePlugin => f !== undefined);
  return [...BASE_BUILTINS, ...inBase];
}

/** Load an enabled packaged platform plugin, or undefined if unavailable. */
async function loadPackagedPlatform(
  id: PlatformId,
  logger: Logger
): Promise<SourcePlugin | undefined> {
  const pkg = PACKAGED_PLATFORMS[id];
  if (!pkg) return undefined;
  try {
    const mod = (await import(pkg)) as {
      createPlugin?: () => SourcePlugin;
      default?: () => SourcePlugin;
    };
    const factory = mod.createPlugin ?? mod.default;
    if (!factory) {
      logger.warn(`platform plugin '${pkg}' has no createPlugin export`);
      return undefined;
    }
    return factory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      logger.warn(
        `platform '${id}' is enabled but '${pkg}' is not installed — ` +
          `run \`claude-in-mobile install ${id}\``
      );
    } else {
      // The package IS installed but failed to load (broken build / bad
      // transitive dep / throw-on-import) — surface it, don't mask as missing.
      logger.error(`platform '${id}': '${pkg}' failed to load`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return undefined;
  }
}

function consoleLogger(): Logger {
  // stderr-only: stdout is reserved for MCP JSON-RPC framing.
  return {
    debug: () => {},
    info: (m, meta) => console.error(`[info] ${m}`, meta ?? ""),
    warn: (m, meta) => console.error(`[warn] ${m}`, meta ?? ""),
    error: (m, meta) => console.error(`[error] ${m}`, meta ?? ""),
  };
}

export async function bootstrapKernelAsync(options: BootstrapOptions = {}): Promise<KernelHandle> {
  const handle = bootstrapKernel(options);

  // Load enabled platforms that ship as separate packages (dynamic import).
  // Skipped entirely when explicit `builtins` are supplied.
  if (!options.builtins) {
    const logger = options.logger ?? consoleLogger();
    const enabled = options.platforms ?? resolveEnabledPlatforms();
    for (const id of enabled) {
      if (!(id in PACKAGED_PLATFORMS)) continue;
      const plugin = await loadPackagedPlatform(id, logger);
      if (plugin) handle.registry.register(plugin);
    }
  }

  if (options.externalPlugins) {
    const loaderOpts =
      typeof options.externalPlugins === "object" ? options.externalPlugins : {};
    const loader = new ExternalPluginLoader({
      ...loaderOpts,
      logger: options.logger,
    });
    const discovered = await loader.discover();
    for (const d of discovered) {
      handle.registry.register(d.factory());
    }
  }
  return handle;
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

  for (const factory of options.builtins ?? defaultBuiltins(options.platforms)) {
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
