/**
 * Meta-tool descriptor barrel.
 *
 * Each cross-platform meta tool (device, screen, ui, …) lives in its own file
 * and exports a `<name>Meta` / `<name>Aliases` pair. Historically the
 * `BuiltinToolsPlugin` had to import each pair by hand (~20 lines) and then
 * re-list every meta tool in a `Record<string, ToolDefinition>` literal to
 * thread it through profile-based visibility — for every new meta tool that
 * was three places to remember to edit.
 *
 * This barrel centralizes the list. Adding a meta tool now means:
 *   1. create `xxx-meta.ts` with `xxxMeta` + `xxxAliases` exports
 *   2. add one entry to `META_TOOL_DESCRIPTORS` below
 *
 * The plugin iterates `META_TOOL_DESCRIPTORS` and uses `MODULE_METADATA` for
 * profile gating — no plugin-side editing required.
 *
 * NOTE: TypeScript has no module-glob import, so the imports below are still
 * one line each. The friction win is having a single barrel/single list rather
 * than three parallel ones spread across files.
 */

import type { ToolDefinition } from "../registry.js";

import { deviceMeta, deviceAliases } from "./device-meta.js";
import { inputMeta, inputAliases } from "./input-meta.js";
import { screenMeta, screenAliases } from "./screen-meta.js";
import { uiMeta, uiAliases } from "./ui-meta.js";
import { appMeta, appAliases } from "./app-meta.js";
import { systemMeta, systemAliases } from "./system-meta.js";
import { browserMeta, browserAliases } from "./browser-meta.js";
import { desktopMeta, desktopAliases } from "./desktop-meta.js";
import { storeMeta, storeAliases } from "./store-meta.js";
import { flowMeta, flowAliases } from "./flow-meta.js";
import { visualMeta, visualAliases } from "./visual-meta.js";
import { recorderMeta, recorderAliases } from "./recorder-meta.js";
import { syncMeta, syncAliases } from "./sync-meta.js";
import { accessibilityMeta, accessibilityAliases } from "./accessibility-meta.js";
import { performanceMeta, performanceAliases } from "./performance-meta.js";
import { autopilotMeta, autopilotAliases } from "./autopilot-meta.js";
import { sandboxMeta, sandboxAliases } from "./sandbox-meta.js";
import { intentMeta, intentAliases } from "./intent-meta.js";
import { sensorMeta, sensorAliases } from "./sensor-meta.js";
import { networkMeta, networkAliases } from "./network-meta.js";

/** Backward-compat alias map shape — canonical tool name + per-call default args. */
export type AliasMap = Record<
  string,
  { tool: string; defaults: Record<string, unknown> }
>;

/**
 * Self-describing record produced by each meta-tool module.
 *
 * - `meta` carries the registry-ready `ToolDefinition` (legacy shape — the
 *   handler receives a `ToolContext`, which the plugin-api `ToolDefinition`
 *   does not model, so registration still goes through the legacy registry).
 * - `aliases` exposes v3.0.x/v3.1.x backward-compat aliases produced by
 *   `createMetaTool` (or hand-rolled in older meta files).
 */
export interface MetaToolDescriptor {
  /** Canonical meta-tool name. Must match `tool.name` and `MODULE_METADATA[].name`. */
  name: string;
  /** Legacy `ToolDefinition` — `{ tool, handler }` with ToolContext-aware handler. */
  meta: ToolDefinition;
  /** Backward-compat aliases. Empty object if the tool has none. */
  aliases: AliasMap;
}

/**
 * The full meta-tool catalogue. Profile-based visibility (which of these are
 * shown vs hidden at startup) is driven by `PROFILE_VISIBLE` /
 * `ALWAYS_VISIBLE` in `profiles.ts` — that mapping is the source of truth, so
 * we deliberately don't duplicate it here.
 */
export const META_TOOL_DESCRIPTORS: readonly MetaToolDescriptor[] = [
  { name: "device", meta: deviceMeta, aliases: deviceAliases },
  { name: "screen", meta: screenMeta, aliases: screenAliases },
  { name: "input", meta: inputMeta, aliases: inputAliases },
  { name: "ui", meta: uiMeta, aliases: uiAliases },
  { name: "app", meta: appMeta, aliases: appAliases },
  { name: "system", meta: systemMeta, aliases: systemAliases },
  { name: "flow", meta: flowMeta, aliases: flowAliases },
  { name: "browser", meta: browserMeta, aliases: browserAliases },
  { name: "desktop", meta: desktopMeta, aliases: desktopAliases },
  { name: "store", meta: storeMeta, aliases: storeAliases },
  { name: "visual", meta: visualMeta, aliases: visualAliases },
  { name: "recorder", meta: recorderMeta, aliases: recorderAliases },
  { name: "sync", meta: syncMeta, aliases: syncAliases },
  { name: "accessibility", meta: accessibilityMeta, aliases: accessibilityAliases },
  { name: "performance", meta: performanceMeta, aliases: performanceAliases },
  { name: "autopilot", meta: autopilotMeta, aliases: autopilotAliases },
  { name: "sandbox", meta: sandboxMeta, aliases: sandboxAliases },
  { name: "intent", meta: intentMeta, aliases: intentAliases },
  { name: "sensor", meta: sensorMeta, aliases: sensorAliases },
  { name: "network", meta: networkMeta, aliases: networkAliases },
];

/**
 * Short / canonical aliases that don't map 1:1 to a single underlying tool
 * (e.g. `autopilot_explore` → `autopilot` with `action:"explore"` default).
 *
 * These previously lived in the BuiltinToolsPlugin literal. Centralizing them
 * here keeps all alias surface in one place; consumers merge them with the
 * per-descriptor `aliases` map.
 */
export const META_SHORT_ALIASES: AliasMap = {
  // autopilot
  autopilot_explore: { tool: "autopilot", defaults: { action: "explore" } },
  autopilot_generate: { tool: "autopilot", defaults: { action: "generate" } },
  autopilot_heal: { tool: "autopilot", defaults: { action: "heal" } },
  autopilot_status: { tool: "autopilot", defaults: { action: "status" } },
  autopilot_tests: { tool: "autopilot", defaults: { action: "tests" } },

  // performance
  perf_snapshot: { tool: "performance", defaults: { action: "snapshot" } },
  perf_baseline: { tool: "performance", defaults: { action: "baseline" } },
  perf_compare: { tool: "performance", defaults: { action: "compare" } },
  perf_monitor: { tool: "performance", defaults: { action: "monitor" } },
  perf_crashes: { tool: "performance", defaults: { action: "crashes" } },
  perf: { tool: "performance", defaults: {} },

  // accessibility
  a11y_audit: { tool: "accessibility", defaults: { action: "audit" } },
  a11y_check: { tool: "accessibility", defaults: { action: "check" } },
  a11y_summary: { tool: "accessibility", defaults: { action: "summary" } },
  a11y_rules: { tool: "accessibility", defaults: { action: "rules" } },
  a11y: { tool: "accessibility", defaults: {} },
};

/**
 * v3.0.x backward-compat aliases — flat names (e.g. `tap`, `screenshot`)
 * that pre-date the meta-tool refactor. These are LLM-facing and must not
 * change shape without a major bump.
 */
export const META_LEGACY_ALIASES: AliasMap = {
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
};
