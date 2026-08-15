/**
 * @mcp-devices/plugin-debug — entry point.
 *
 * Exports createPlugin() (named + default) following the plugin-android pattern.
 * The kernel resolves this via dynamic import and calls createPlugin()/default().
 */

import type { SourcePlugin } from "@mcp-devices/plugin-api";
import { DebugPlugin } from "./plugin.js";

export { DebugPlugin } from "./plugin.js";
export { DebugController } from "./controller.js";
export type { DebugPlatform, AttachResult } from "./controller.js";

/** Factory — creates a fresh DebugPlugin instance. */
export function createDebugPlugin(): SourcePlugin {
  return new DebugPlugin();
}

// Both named and default exports so the kernel can use either.
export const createPlugin = createDebugPlugin;
export default createDebugPlugin;
