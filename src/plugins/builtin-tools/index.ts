/**
 * Built-in tools plugin.
 *
 * Owns registration of the cross-platform meta tools (`device`, `screen`,
 * `ui`, ...), their v3.0.x/v3.1.x backward-compat aliases, and the module
 * metadata catalog. Previously this lived inline at the top of
 * `src/index.ts`; phase D4 of the 3.12.0 plugin migration moves it behind a
 * `SourcePlugin` so the entry point no longer has to know about the
 * meta-tool surface.
 *
 * Design notes
 * ------------
 * - Meta tools use the legacy `ToolDefinition` shape (`{ tool, handler }`)
 *   carrying a `ToolContext` per call. The plugin-api `ToolDefinition`
 *   doesn't model that context, and `PluginContext.registerTool` only
 *   accepts the plugin-api shape. The smaller-risk option (chosen here) is
 *   to register meta tools through the legacy `registerTools` /
 *   `registerToolsHidden` functions directly — exactly as `index.ts` did
 *   before. This keeps the public effect identical: visible meta tools end
 *   up in `toolMap`, hidden ones in `toolMap + hiddenTools`. Extending
 *   `PluginContext` to carry a typed tool-context is a separate scope.
 * - Aliases and module metadata are registered through the legacy registry
 *   functions for the same reason. The plugin lifecycle is still
 *   responsible for *when* this happens — `init()` is awaited by
 *   `kernel.initAll()`, which is itself awaited before `freezeRegistry()`
 *   in `src/index.ts`, so ordering is preserved.
 * - Profile resolution moves into the plugin: it reads `MOBILE_PROFILE`
 *   from `ctx.config` first (forwarded by the kernel via `configFor` if a
 *   host ever opts in), falling back to `process.env.MOBILE_PROFILE` to
 *   keep behaviour identical for the MCP entry point.
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
} from "@claude-in-mobile/plugin-api";

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

import { deviceMeta, deviceAliases } from "../../tools/meta/device-meta.js";
import { inputMeta, inputAliases } from "../../tools/meta/input-meta.js";
import { screenMeta, screenAliases } from "../../tools/meta/screen-meta.js";
import { uiMeta, uiAliases } from "../../tools/meta/ui-meta.js";
import { appMeta, appAliases } from "../../tools/meta/app-meta.js";
import { systemMeta, systemAliases } from "../../tools/meta/system-meta.js";
import { browserMeta, browserAliases } from "../../tools/meta/browser-meta.js";
import { desktopMeta, desktopAliases } from "../../tools/meta/desktop-meta.js";
import { storeMeta, storeAliases } from "../../tools/meta/store-meta.js";
import { flowMeta, flowAliases } from "../../tools/meta/flow-meta.js";
import { visualMeta, visualAliases } from "../../tools/meta/visual-meta.js";
import { recorderMeta, recorderAliases } from "../../tools/meta/recorder-meta.js";
import { syncMeta, syncAliases } from "../../tools/meta/sync-meta.js";
import { accessibilityMeta, accessibilityAliases } from "../../tools/meta/accessibility-meta.js";
import { performanceMeta, performanceAliases } from "../../tools/meta/performance-meta.js";
import { autopilotMeta, autopilotAliases } from "../../tools/meta/autopilot-meta.js";
import { sandboxMeta, sandboxAliases } from "../../tools/meta/sandbox-meta.js";
import { intentMeta, intentAliases } from "../../tools/meta/intent-meta.js";
import { sensorMeta, sensorAliases } from "../../tools/meta/sensor-meta.js";
import { networkMeta, networkAliases } from "../../tools/meta/network-meta.js";

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
function resolveActiveProfile(
  ctx: PluginContext
): MobileProfile {
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

    // All meta tools by name for profile-aware split.
    const allMetaTools: Record<string, ToolDefinition> = {
      device: deviceMeta,
      screen: screenMeta,
      input: inputMeta,
      ui: uiMeta,
      app: appMeta,
      system: systemMeta,
      flow: flowMeta,
      browser: browserMeta,
      desktop: desktopMeta,
      store: storeMeta,
      visual: visualMeta,
      recorder: recorderMeta,
      sync: syncMeta,
      accessibility: accessibilityMeta,
      performance: performanceMeta,
      autopilot: autopilotMeta,
      sandbox: sandboxMeta,
      intent: intentMeta,
      sensor: sensorMeta,
      network: networkMeta,
    };

    const profileVisible = new Set([
      ...ALWAYS_VISIBLE,
      ...PROFILE_VISIBLE[active],
    ]);
    const visibleTools: ToolDefinition[] = [];
    const hiddenToolDefs: ToolDefinition[] = [];

    for (const [name, def] of Object.entries(allMetaTools)) {
      if (profileVisible.has(name)) {
        visibleTools.push(def);
      } else {
        hiddenToolDefs.push(def);
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

    registerAliasesWithDefaults({
      // v3.1.x canonical -> meta tool aliases
      ...deviceAliases,
      ...inputAliases,
      ...screenAliases,
      ...uiAliases,
      ...appAliases,
      ...systemAliases,
      ...browserAliases,
      ...desktopAliases,
      ...storeAliases,
      ...flowAliases,
      ...visualAliases,
      ...recorderAliases,
      ...syncAliases,
      ...accessibilityAliases,
      ...performanceAliases,
      ...autopilotAliases,
      ...sandboxAliases,
      ...intentAliases,
      ...sensorAliases,
      ...networkAliases,

      // Short aliases for autopilot
      autopilot_explore: { tool: "autopilot", defaults: { action: "explore" } },
      autopilot_generate: { tool: "autopilot", defaults: { action: "generate" } },
      autopilot_heal: { tool: "autopilot", defaults: { action: "heal" } },
      autopilot_status: { tool: "autopilot", defaults: { action: "status" } },
      autopilot_tests: { tool: "autopilot", defaults: { action: "tests" } },

      // Short aliases for performance
      perf_snapshot: { tool: "performance", defaults: { action: "snapshot" } },
      perf_baseline: { tool: "performance", defaults: { action: "baseline" } },
      perf_compare: { tool: "performance", defaults: { action: "compare" } },
      perf_monitor: { tool: "performance", defaults: { action: "monitor" } },
      perf_crashes: { tool: "performance", defaults: { action: "crashes" } },
      perf: { tool: "performance", defaults: {} },

      // Short aliases for accessibility
      a11y_audit: { tool: "accessibility", defaults: { action: "audit" } },
      a11y_check: { tool: "accessibility", defaults: { action: "check" } },
      a11y_summary: { tool: "accessibility", defaults: { action: "summary" } },
      a11y_rules: { tool: "accessibility", defaults: { action: "rules" } },
      a11y: { tool: "accessibility", defaults: {} },

      // v3.0.x backward compat aliases -> meta tools
      // device
      list_devices: { tool: "device", defaults: { action: "list" } },
      set_device: { tool: "device", defaults: { action: "set" } },
      set_target: { tool: "device", defaults: { action: "set_target" } },
      get_target: { tool: "device", defaults: { action: "get_target" } },
      // interaction
      tap: { tool: "input", defaults: { action: "tap" } },
      double_tap: { tool: "input", defaults: { action: "double_tap" } },
      long_press: { tool: "input", defaults: { action: "long_press" } },
      swipe: { tool: "input", defaults: { action: "swipe" } },
      press_key: { tool: "input", defaults: { action: "key" } },
      // ui
      get_ui: { tool: "ui", defaults: { action: "tree" } },
      find_element: { tool: "ui", defaults: { action: "find" } },
      find_and_tap: { tool: "ui", defaults: { action: "find_tap" } },
      tap_by_text: { tool: "ui", defaults: { action: "tap_text" } },
      analyze_screen: { tool: "ui", defaults: { action: "analyze" } },
      wait_for_element: { tool: "ui", defaults: { action: "wait" } },
      assert_visible: { tool: "ui", defaults: { action: "assert_visible" } },
      assert_not_exists: { tool: "ui", defaults: { action: "assert_gone" } },
      // system
      get_current_activity: { tool: "system", defaults: { action: "activity" } },
      shell: { tool: "system", defaults: { action: "shell" } },
      wait: { tool: "system", defaults: { action: "wait" } },
      open_url: { tool: "system", defaults: { action: "open_url" } },
      get_logs: { tool: "system", defaults: { action: "logs" } },
      clear_logs: { tool: "system", defaults: { action: "clear_logs" } },
      get_system_info: { tool: "system", defaults: { action: "info" } },
      get_webview: { tool: "system", defaults: { action: "webview" } },
      // app
      launch_app: { tool: "app", defaults: { action: "launch" } },
      stop_app: { tool: "app", defaults: { action: "stop" } },
      install_app: { tool: "app", defaults: { action: "install" } },
      list_apps: { tool: "app", defaults: { action: "list" } },
      // screenshot
      screenshot: { tool: "screen", defaults: { action: "capture" } },
      annotate_screenshot: { tool: "screen", defaults: { action: "annotate" } },
      // desktop
      launch_desktop_app: { tool: "desktop", defaults: { action: "launch" } },
      stop_desktop_app: { tool: "desktop", defaults: { action: "stop" } },
      get_window_info: { tool: "desktop", defaults: { action: "windows" } },
      focus_window: { tool: "desktop", defaults: { action: "focus" } },
      resize_window: { tool: "desktop", defaults: { action: "resize" } },
      get_clipboard: { tool: "desktop", defaults: { action: "clipboard_get" } },
      set_clipboard: { tool: "desktop", defaults: { action: "clipboard_set" } },
      get_performance_metrics: { tool: "desktop", defaults: { action: "performance" } },
      get_monitors: { tool: "desktop", defaults: { action: "monitors" } },
      // clipboard (Android)
      select_text: { tool: "system", defaults: { action: "clipboard_select" } },
      copy_text: { tool: "system", defaults: { action: "clipboard_copy" } },
      paste_text: { tool: "system", defaults: { action: "clipboard_paste" } },
      get_clipboard_android: { tool: "system", defaults: { action: "clipboard_get" } },
      // flow
      batch_commands: { tool: "flow", defaults: { action: "batch" } },
      run_flow: { tool: "flow", defaults: { action: "run" } },
      parallel: { tool: "flow", defaults: { action: "parallel" } },
      // permissions
      grant_permission: { tool: "system", defaults: { action: "permission_grant" } },
      revoke_permission: { tool: "system", defaults: { action: "permission_revoke" } },
      reset_permissions: { tool: "system", defaults: { action: "permission_reset" } },
      // file (aurora)
      push_file: { tool: "system", defaults: { action: "file_push" } },
      pull_file: { tool: "system", defaults: { action: "file_pull" } },

      // LLM misnaming helpers
      press_button: { tool: "input", defaults: { action: "key" } },
      type_text: { tool: "input", defaults: { action: "text" } },
      type: { tool: "input", defaults: { action: "text" } },
      click: { tool: "input", defaults: { action: "tap" } },
      long_tap: { tool: "input", defaults: { action: "long_press" } },
      take_screenshot: { tool: "screen", defaults: { action: "capture" } },
    });
  }
}

export function createBuiltinToolsPlugin(): SourcePlugin {
  return new BuiltinToolsPlugin();
}
