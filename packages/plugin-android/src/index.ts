/**
 * Built-in Android plugin.
 *
 * Wraps the existing AndroidAdapter without modifying its behavior. The
 * adapter remains the implementation; the plugin layer adds the kernel
 * contract (manifest, lifecycle, capabilities) on top.
 *
 * Phase 2 migration: AndroidAdapter is kept intact and accessed through
 * `plugin.adapter`. DeviceManager continues to route through the adapter
 * directly for backward compatibility until Phase 5 turns it into a facade
 * over the plugin registry.
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
} from "@mcp-devices/plugin-api";

import { AndroidAdapter } from "./android-adapter.js";

export const ANDROID_PLUGIN_MANIFEST: PluginManifest = {
  id: "android",
  name: "Android",
  version: "3.11.0",
  apiVersion: "1",
  capabilities: [
    "screen",
    "input",
    "ui",
    "shell",
    "appLifecycle",
    "permissions",
    "logs",
    "deviceMgmt",
  ],
  description: "Android automation via ADB (screen, input, app lifecycle, shell, logs)",
};

export class AndroidPlugin implements SourcePlugin {
  readonly manifest = ANDROID_PLUGIN_MANIFEST;
  readonly adapter: AndroidAdapter;

  constructor(adapter: AndroidAdapter = new AndroidAdapter()) {
    this.adapter = adapter;
  }

  init(_ctx: PluginContext): void {
    // No tool registration in Phase 2 — existing MCP tools still wire through
    // device-manager. Phase 5 will move tool registration here.
  }
}

export function createAndroidPlugin(): SourcePlugin {
  return new AndroidPlugin();
}

export { AndroidAdapter } from "./android-adapter.js";
export { WebViewInspector } from "./adb/webview.js";
export const createPlugin = createAndroidPlugin;
export default createAndroidPlugin;
