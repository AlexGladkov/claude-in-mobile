/**
 * Built-in iOS plugin.
 *
 * Wraps the existing IosAdapter. See src/plugins/android/index.ts for the
 * Phase 2 migration pattern that applies here verbatim.
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
} from "@claude-in-mobile/plugin-api";

import { IosAdapter } from "../../adapters/ios-adapter.js";

export const IOS_PLUGIN_MANIFEST: PluginManifest = {
  id: "ios",
  name: "iOS",
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
  description: "iOS Simulator automation via simctl (screen, input, app lifecycle, shell, logs)",
};

export class IosPlugin implements SourcePlugin {
  readonly manifest = IOS_PLUGIN_MANIFEST;
  readonly adapter: IosAdapter;

  constructor(adapter: IosAdapter = new IosAdapter()) {
    this.adapter = adapter;
  }

  init(_ctx: PluginContext): void {}
}

export function createIosPlugin(): SourcePlugin {
  return new IosPlugin();
}
