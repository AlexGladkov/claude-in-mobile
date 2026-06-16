/**
 * Built-in Aurora OS plugin.
 *
 * Wraps AuroraAdapter. Aurora supports app lifecycle, shell, and logs but
 * does NOT have runtime permissions.
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
} from "@claude-in-mobile/plugin-api";

import { AuroraAdapter } from "./aurora-adapter.js";

export const AURORA_PLUGIN_MANIFEST: PluginManifest = {
  id: "aurora",
  name: "Aurora OS",
  version: "3.11.0",
  apiVersion: "1",
  capabilities: ["screen", "input", "ui", "shell", "appLifecycle", "logs", "deviceMgmt"],
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
