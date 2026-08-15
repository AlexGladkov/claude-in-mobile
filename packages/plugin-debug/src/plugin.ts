/**
 * DebugPlugin — the SourcePlugin wrapper for the debug controller + tools.
 *
 * Capability "meta-tools": this is NOT a platform plugin; findByCapability("screen")
 * must not return it. It registers 12 MCP tools via ctx.registerTool().
 *
 * Security: dispose() tears down all sessions → guaranteed teardown invariant (I3).
 */

import type { PluginContext, PluginManifest, SourcePlugin } from "@mcp-devices/plugin-api";
import { DebugController } from "./controller.js";
import { buildDebugTools } from "./tools.js";

export const DEBUG_PLUGIN_MANIFEST: PluginManifest = {
  id: "debug",
  name: "Debug",
  version: "4.0.0",
  apiVersion: "1",
  // "meta-tools" marks this as a cross-platform tool provider, NOT a device
  // platform. findByCapability("screen") must not return this plugin.
  capabilities: ["meta-tools"],
  description:
    "Runtime debugger for Android (JDWP) and iOS Simulator (LLDB): breakpoints, " +
    "event polling, frame inspection, eval, step, set-var.",
};

export class DebugPlugin implements SourcePlugin {
  readonly manifest = DEBUG_PLUGIN_MANIFEST;
  private controller?: DebugController;

  init(ctx: PluginContext): void {
    // One DebugController for the plugin's lifetime — holds sessions across tool calls.
    this.controller = new DebugController();
    const tools = buildDebugTools(this.controller);
    for (const tool of tools) {
      ctx.registerTool(tool);
    }
    ctx.logger.info(`[debug] registered ${tools.length} tools`);
  }

  async dispose(): Promise<void> {
    // SECURITY I3: guaranteed teardown on plugin dispose — removes all adb forwards,
    // kills the LLDB daemon, disposes all JDWP sessions.
    await this.controller?.disposeAll();
    this.controller = undefined;
  }
}
