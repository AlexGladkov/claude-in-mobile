/**
 * Built-in Web plugin (Chrome via CDP).
 *
 * Wraps BrowserAdapter. Browser has no shell, no app lifecycle, no
 * permissions — capabilities reflect that minimal surface.
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
} from "@mcp-devices/plugin-api";

import { BrowserAdapter } from "./browser-adapter.js";

export const WEB_PLUGIN_MANIFEST: PluginManifest = {
  id: "web",
  name: "Web (Chrome)",
  version: "3.11.0",
  apiVersion: "1",
  capabilities: ["screen", "input", "ui"],
  description: "Browser automation via Chrome DevTools Protocol",
};

export class WebPlugin implements SourcePlugin {
  readonly manifest = WEB_PLUGIN_MANIFEST;
  readonly adapter: BrowserAdapter;

  constructor(adapter: BrowserAdapter = new BrowserAdapter()) {
    this.adapter = adapter;
  }

  init(_ctx: PluginContext): void {}
}

export function createWebPlugin(): SourcePlugin {
  return new WebPlugin();
}

export { BrowserAdapter } from "./browser-adapter.js";
export const createPlugin = createWebPlugin;
export default createWebPlugin;
