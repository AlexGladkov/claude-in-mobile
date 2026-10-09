/**
 * Built-in Aurora OS plugin.
 *
 * Wraps AuroraAdapter with screenshots, input, apps, files, diagnostics
 * and Sailjail permissions through audb ^0.3.0.
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
} from "@mcp-devices/plugin-api";

import { AuroraAdapter } from "./aurora-adapter.js";

export const AURORA_PLUGIN_MANIFEST: PluginManifest = {
  id: "aurora",
  name: "Aurora OS",
  version: "4.4.1",
  apiVersion: "1",
  capabilities: [
    "screen",
    "input",
    "shell",
    "appLifecycle",
    "permissions",
    "logs",
    "fileTransfer",
    "deviceMgmt",
  ],
  description: "Aurora OS automation via audb (screen, input, app lifecycle, shell, logs)",
};

export class AuroraPlugin implements SourcePlugin {
  readonly manifest = AURORA_PLUGIN_MANIFEST;
  readonly adapter: AuroraAdapter;

  constructor(adapter: AuroraAdapter = new AuroraAdapter()) {
    this.adapter = adapter;
  }

  init(_ctx: PluginContext): void {}
}

export function createAuroraPlugin(): SourcePlugin {
  return new AuroraPlugin();
}

export { AuroraAdapter } from "./aurora-adapter.js";
export { AuroraClient, auroraClient } from "./client.js";
export const createPlugin = createAuroraPlugin;
export default createAuroraPlugin;
