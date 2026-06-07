/**
 * Built-in Desktop plugin.
 *
 * Wraps the existing DesktopAdapter (Compose desktop companion via JSON-RPC).
 * Desktop has no runtime permissions and no sync screenshot — capabilities
 * reflect that.
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
} from "@claude-in-mobile/plugin-api";

import { DesktopAdapter } from "../../adapters/desktop-adapter.js";

export const DESKTOP_PLUGIN_MANIFEST: PluginManifest = {
  id: "desktop",
  name: "Desktop",
  version: "3.11.0",
  apiVersion: "1",
  capabilities: ["screen", "input", "ui", "shell", "appLifecycle", "logs", "deviceMgmt"],
  description: "Desktop automation via Compose companion JSON-RPC (screen, input, app lifecycle, shell)",
};

export class DesktopPlugin implements SourcePlugin {
  readonly manifest = DESKTOP_PLUGIN_MANIFEST;
  readonly adapter: DesktopAdapter;

  constructor(adapter: DesktopAdapter = new DesktopAdapter()) {
    this.adapter = adapter;
  }

  init(_ctx: PluginContext): void {}
}

export function createDesktopPlugin(): SourcePlugin {
  return new DesktopPlugin();
}
