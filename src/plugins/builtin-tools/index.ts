/**
 * Built-in tools plugin.
 *
 * Owns registration of the cross-platform meta tools (`device`, `screen`,
 * `ui`, ...), their v3.0.x/v3.1.x backward-compat aliases, and the module
 * metadata catalog.
 *
 * History
 * -------
 * - D4 (3.12.0) moved meta-tool registration out of `src/index.ts` into this
 *   plugin so the entry point no longer hard-codes the meta-tool surface.
 * - D8.3 (3.12.0) moved the meta-tool *catalogue* out of this plugin into
 *   `src/tools/meta/index.ts`. The plugin no longer enumerates every meta
 *   tool — it iterates `META_TOOL_DESCRIPTORS` and forwards aliases from
 *   `META_SHORT_ALIASES` / `META_LEGACY_ALIASES`. Adding a meta tool means
 *   touching the barrel only; this file is now stable.
 *
 * Design notes
 * ------------
 * - Meta tools use the legacy `ToolDefinition` shape (`{ tool, handler }`)
 *   carrying a `ToolContext` per call. The plugin-api `ToolDefinition`
 *   doesn't model that context, and `PluginContext.registerTool` only
 *   accepts the plugin-api shape — so registration goes through the legacy
 *   `registerTools` / `registerToolsHidden` functions directly. This keeps
 *   the public effect identical: visible meta tools end up in `toolMap`,
 *   hidden ones in `toolMap + hiddenTools`. Extending `PluginContext` to
 *   carry a typed tool-context is a separate scope.
 * - Profile resolution stays here: it reads `MOBILE_PROFILE` from
 *   `ctx.config` first (forwarded by the kernel via `configFor` if a host
 *   ever opts in), falling back to `process.env.MOBILE_PROFILE` to keep
 *   behaviour identical for the MCP entry point.
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
} from "@mcp-devices/plugin-api";

import {
  registerTools,
  registerToolsHidden,
  registerAliasesWithDefaults,
  registerAllModuleMetadata,
  type ToolDefinition,
} from "../../tools/registry.js";
import {
  ALWAYS_VISIBLE,
  PROFILE_VISIBLE,
  VALID_PROFILES,
  MODULE_METADATA,
  type MobileProfile,
} from "../../profiles.js";
import {
  META_TOOL_DESCRIPTORS,
  META_SHORT_ALIASES,
  META_LEGACY_ALIASES,
} from "../../tools/meta/index.js";

export const BUILTIN_TOOLS_PLUGIN_MANIFEST: PluginManifest = {
  id: "builtin-tools",
  name: "Built-in tools",
  version: "3.12.0",
  apiVersion: "1",
  // Marker-only capability — meta-tools fan out to platform plugins, so we
  // must not show up in `findByCapability("screen")` etc.
  capabilities: ["meta-tools"],
  description:
    "Cross-platform meta tools (device, screen, input, ui, app, system, ...) plus v3.0.x/v3.1.x backward-compat aliases and module metadata.",
};

/** Resolve the active MOBILE_PROFILE with the same fallback warning as the legacy entry point. */
function resolveActiveProfile(ctx: PluginContext): MobileProfile {
  const configRaw =
    typeof ctx.config["MOBILE_PROFILE"] === "string"
      ? (ctx.config["MOBILE_PROFILE"] as string)
      : undefined;
  const raw = configRaw ?? process.env.MOBILE_PROFILE ?? "core";
  if (VALID_PROFILES.includes(raw as MobileProfile)) {
    return raw as MobileProfile;
  }
  ctx.logger.warn(
    `[profiles] Invalid MOBILE_PROFILE="${raw}". Valid: ${VALID_PROFILES.join(", ")}. Falling back to "core".`
  );
  return "core";
}

export class BuiltinToolsPlugin implements SourcePlugin {
  readonly manifest = BUILTIN_TOOLS_PLUGIN_MANIFEST;

  init(ctx: PluginContext): void {
    const active = resolveActiveProfile(ctx);

    const profileVisible = new Set([
      ...ALWAYS_VISIBLE,
      ...PROFILE_VISIBLE[active],
    ]);
    const visibleTools: ToolDefinition[] = [];
    const hiddenToolDefs: ToolDefinition[] = [];

    for (const { name, meta } of META_TOOL_DESCRIPTORS) {
      if (profileVisible.has(name)) {
        visibleTools.push(meta);
      } else {
        hiddenToolDefs.push(meta);
      }
    }

    // Legacy registry — `PluginContext.registerTool` would lose the
    // ToolContext-aware handler signature. See header comment.
    registerTools(visibleTools);
    if (hiddenToolDefs.length > 0) {
      registerToolsHidden(hiddenToolDefs);
    }

    registerAllModuleMetadata(MODULE_METADATA);

    ctx.logger.info(
      `[profiles] MOBILE_PROFILE="${active}" — ${visibleTools.length} visible, ${hiddenToolDefs.length} hidden`
    );

    // Merge alias maps. Order preserves legacy behaviour:
    //   1. per-descriptor aliases (one-to-one with underlying tool names)
    //   2. short aliases (autopilot_*, perf_*, a11y_*)
    //   3. v3.0.x legacy aliases (tap, screenshot, …)
    // Later spreads win on key conflicts — in practice the three sets are
    // disjoint, but the order matches the original literal at the bottom of
    // this file pre-D8.3.
    const allAliases = Object.assign(
      {},
      ...META_TOOL_DESCRIPTORS.map((d) => d.aliases),
      META_SHORT_ALIASES,
      META_LEGACY_ALIASES
    );
    registerAliasesWithDefaults(allAliases);
  }
}

export function createBuiltinToolsPlugin(): SourcePlugin {
  return new BuiltinToolsPlugin();
}
