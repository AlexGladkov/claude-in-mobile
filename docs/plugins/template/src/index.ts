/**
 * Plugin template — copy this directory into `src/plugins/<your-id>/` and
 * rename. See docs/plugins/authoring.md for the full walkthrough.
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
} from "@claude-in-mobile/plugin-api";

export const TEMPLATE_PLUGIN_MANIFEST: PluginManifest = {
  id: "template",
  name: "Template",
  version: "0.0.0",
  apiVersion: "1",
  capabilities: ["screen"],
  tools: ["template_ping"],
  description: "Replace this description with your plugin's purpose.",
};

export class TemplatePlugin implements SourcePlugin {
  readonly manifest = TEMPLATE_PLUGIN_MANIFEST;

  init(ctx: PluginContext): void {
    ctx.registerTool({
      name: "template_ping",
      description: "Returns a static payload — replace with real behavior.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ pong: true }),
    });
  }

  async dispose(): Promise<void> {
    // Release resources owned by the plugin: kill child processes, close
    // sockets, flush buffers, …
  }
}

export function createTemplatePlugin(): SourcePlugin {
  return new TemplatePlugin();
}
