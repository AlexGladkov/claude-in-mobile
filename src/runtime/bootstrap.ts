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

import { PluginContractError } from "@mcp-devices/plugin-api";
import type {
  Logger,
  SourcePlugin,
  ToolDefinition,
} from "@mcp-devices/plugin-api";

import { InMemoryEventBus } from "../kernel/eventbus.js";
import { InMemoryRegistry } from "../kernel/registry.js";
import type { PluginRegistry } from "../kernel/registry.js";
import { LifecycleOrchestrator } from "../kernel/lifecycle.js";
import { CapabilityResolver } from "../kernel/resolver.js";
import { ExternalPluginLoader } from "../kernel/external-loader.js";
import { assertToolsAvailable } from "../tools/registry.js";
import { sanitizeErrorMessage } from "../utils/sanitize.js";

import { createBuiltinToolsPlugin } from "../plugins/builtin-tools/index.js";
import { createReplPlugin } from "../plugins/repl/index.js";
import { resolveEnabledPlatforms } from "./platform-config.js";
import type { PlatformId } from "./platform-config.js";
import { resolveEnabledToolPlugins } from "./tool-plugin-config.js";
import type { ToolPluginId } from "./tool-plugin-config.js";

export interface KernelHandle {
  readonly registry: PluginRegistry;
  readonly eventBus: InMemoryEventBus;
  readonly resolver: CapabilityResolver;
  readonly lifecycle: LifecycleOrchestrator;
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  readonly toolOwners: ReadonlyMap<string, string>;
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
   * - `true`  → scan `~/.mcp-devices/plugins/` (default off — opt-in for now)
   * - object  → forwarded to `ExternalPluginLoader` for custom roots/api versions
   */
  externalPlugins?: boolean | {
    additionalRoots?: ReadonlyArray<string>;
    supportedApiVersions?: ReadonlyArray<string>;
  };
  /**
   * Which platform plugins to load. When omitted, resolved from
   * `MCP_DEVICES_PLATFORMS` / `~/.mcp-devices/config.json` /
   * default (none). Ignored if `builtins` is supplied explicitly.
   */
  platforms?: ReadonlyArray<PlatformId>;
  /**
   * Which tool plugins to load (e.g. ["debug"]). When omitted, resolved from
   * `MCP_DEVICES_TOOL_PLUGINS` env / config.json `tool_plugins` / default (none).
   * Tool plugins register MCP tools via ctx.registerTool() but are NOT platforms.
   */
  toolPlugins?: ReadonlyArray<ToolPluginId>;
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
 * `@mcp-devices/plugin-*` packages (4.0.0 physical split), they move
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
  aurora: "@mcp-devices/plugin-aurora",
  harmony: "@mcp-devices/plugin-harmony",
  web: "@mcp-devices/plugin-web",
  desktop: "@mcp-devices/plugin-desktop",
  android: "@mcp-devices/plugin-android",
  ios: "@mcp-devices/plugin-ios",
};

/**
 * Tool plugins delivered as separate npm packages. Unlike platform plugins they
 * are NOT bound to PlatformId and do NOT appear in ALL_PLATFORMS. They provide
 * cross-cutting MCP tools (e.g. debug = JDWP + LLDB). Each is opt-in (off by
 * default). Missing packages degrade gracefully — no kernel crash.
 */
const PACKAGED_TOOL_PLUGINS: Record<ToolPluginId, string> = {
  debug: "@mcp-devices/plugin-debug",
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
    const msg = err instanceof Error ? err.message : String(err);
    // ERR_MODULE_NOT_FOUND fires both for a missing package AND for a missing
    // import *inside* an installed package. Node's ESM loader says "Cannot find
    // package '<spec>'" only for the genuinely-absent package; a broken install
    // says "Cannot find module '<path>'" or ERR_PACKAGE_PATH_NOT_EXPORTED.
    const isMissingPackage =
      (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
      msg.includes("Cannot find package");
    if (isMissingPackage) {
      logger.warn(
        `platform '${id}' is enabled but '${pkg}' is not installed — ` +
          `run \`mcp-devices install ${id}\``
      );
    } else {
      // The package IS installed but failed to load (broken build / bad
      // transitive dep / throw-on-import) — surface it, don't mask as missing.
      logger.error(`platform '${id}': '${pkg}' failed to load`, {
        error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)).slice(0, 1000),
      });
    }
    return undefined;
  }
}

/**
 * Load an enabled tool plugin package, or return undefined if unavailable.
 * Mirrors the graceful-missing semantics of loadPackagedPlatform — the kernel
 * does not crash when the package is not installed.
 */
async function loadToolPlugin(
  id: ToolPluginId,
  logger: Logger,
): Promise<SourcePlugin | undefined> {
  const pkg = PACKAGED_TOOL_PLUGINS[id];
  try {
    const mod = (await import(pkg)) as {
      createPlugin?: () => SourcePlugin;
      default?: () => SourcePlugin;
    };
    const factory = mod.createPlugin ?? mod.default;
    if (!factory) {
      logger.warn(`tool plugin '${pkg}' has no createPlugin export`);
      return undefined;
    }
    return factory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const msg = err instanceof Error ? err.message : String(err);
    const isMissingPackage =
      (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
      msg.includes("Cannot find package");
    if (isMissingPackage) {
      logger.warn(
        `tool plugin '${id}' is enabled but '${pkg}' is not installed — ` +
          `run \`npm install ${pkg}\` or \`mcp-devices install ${id}\``,
      );
    } else {
      logger.error(`tool plugin '${id}': '${pkg}' failed to load`, {
        error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)).slice(0, 1000),
      });
    }
    return undefined;
  }
}

function writeConsoleLog(
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
): void {
  const safeMessage = sanitizeErrorMessage(message).replace(/\n/g, "\\n");
  let safeMeta = "";
  if (meta !== undefined) {
    try {
      safeMeta = sanitizeErrorMessage(JSON.stringify(meta)).replace(/\n/g, "\\n");
    } catch {
      safeMeta = "[unserializable metadata]";
    }
  }
  console.error(`[${level}] ${safeMessage}${safeMeta ? ` ${safeMeta}` : ""}`);
}

function consoleLogger(): Logger {
  // stderr-only: stdout is reserved for MCP JSON-RPC framing.
  return {
    debug: () => {},
    info: (message, meta) => writeConsoleLog("info", message, meta),
    warn: (message, meta) => writeConsoleLog("warn", message, meta),
    error: (message, meta) => writeConsoleLog("error", message, meta),
  };
}

export async function bootstrapKernelAsync(options: BootstrapOptions = {}): Promise<KernelHandle> {
  const handle = bootstrapKernel(options);
  const logger = options.logger ?? consoleLogger();

  // Load enabled platforms that ship as separate packages (dynamic import).
  // Skipped entirely when explicit `builtins` are supplied.
  if (!options.builtins) {
    const enabled = options.platforms ?? resolveEnabledPlatforms();
    for (const id of enabled) {
      if (!(id in PACKAGED_PLATFORMS)) continue;
      const plugin = await loadPackagedPlatform(id, logger);
      if (plugin) handle.registry.register(plugin);
    }

    // Load enabled tool plugins (debug, etc.) — NOT platforms; NOT in ALL_PLATFORMS.
    // Registered tools flow into the existing tools Map → served by MCP.
    const enabledToolPlugins = options.toolPlugins ?? resolveEnabledToolPlugins();
    for (const id of enabledToolPlugins) {
      const plugin = await loadToolPlugin(id, logger);
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
    for (const plugin of discovered) {
      try {
        handle.registry.register(plugin.factory());
      } catch (error) {
        logger.error("external plugin registration failed", {
          source: sanitizeErrorMessage(plugin.source).slice(0, 1000),
          error: sanitizeErrorMessage(
            error instanceof Error ? error.message : String(error),
          ).slice(0, 1000),
        });
      }
    }
  }
  return handle;
}

export function bootstrapKernel(options: BootstrapOptions = {}): KernelHandle {
  const registry = new InMemoryRegistry();
  const eventBus = new InMemoryEventBus();
  const logger = options.logger ?? consoleLogger();
  const tools = new Map<string, ToolDefinition>();
  const toolOwners = new Map<string, string>();

  const lifecycle = new LifecycleOrchestrator({
    registry,
    eventBus,
    logger,
    configFor: options.configFor ?? (() => ({})),
    registerTools: (pluginId, defs) => {
      try {
        assertToolsAvailable(defs.map((def) => def.name), pluginId);
      } catch (error) {
        throw new PluginContractError(
          error instanceof Error ? error.message : String(error),
          pluginId,
        );
      }
      const staged = new Set<string>();
      for (const def of defs) {
        const name = def.name.trim();
        if (!name || name !== def.name) {
          throw new PluginContractError(
            "tool name must be non-empty and have no surrounding whitespace",
            pluginId,
          );
        }
        if (staged.has(name)) {
          throw new PluginContractError(`tool '${name}' is registered twice`, pluginId);
        }
        staged.add(name);
        const owner = toolOwners.get(name);
        if (owner) {
          throw new PluginContractError(
            `tool '${name}' conflicts with owner '${owner}'`,
            pluginId,
          );
        }
      }
      for (const def of defs) {
        tools.set(def.name, def);
        toolOwners.set(def.name, pluginId);
      }
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
    toolOwners,
    async initAll() {
      await lifecycle.initAll();
      resolver.invalidate();
    },
    async disposeAll() {
      await lifecycle.disposeAll();
      resolver.invalidate();
    },
    getPlugin<T extends SourcePlugin = SourcePlugin>(id: string): T | undefined {
      return registry.get(id)?.plugin as T | undefined;
    },
  };
}
