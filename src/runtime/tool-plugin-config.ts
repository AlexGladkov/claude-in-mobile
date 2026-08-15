/**
 * Tool-plugin enablement config — which tool plugins the kernel loads.
 *
 * Mirrors the pattern of platform-config.ts / resolveEnabledPlatforms().
 *
 * Resolution order (first wins):
 *   1. `MCP_DEVICES_TOOL_PLUGINS` env (csv, e.g. "debug" or "debug,profiler")
 *   2. `~/.mcp-devices/config.json` → `{ "tool_plugins": [...] }`
 *   3. default: empty set (tool plugins are opt-in; debug is off by default)
 *
 * Tool plugins are NOT platform plugins — they do not appear in ALL_PLATFORMS /
 * PlatformId. A missing package degrades gracefully (plugin unavailable, no crash).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Well-known tool plugin identifiers. Extend as new tool plugins ship. */
export const ALL_TOOL_PLUGINS = ["debug"] as const;
export type ToolPluginId = (typeof ALL_TOOL_PLUGINS)[number];

function isToolPluginId(s: string): s is ToolPluginId {
  return (ALL_TOOL_PLUGINS as readonly string[]).includes(s);
}

function configPath(): string {
  return join(homedir(), ".mcp-devices", "config.json");
}

/** Parse a csv tool-plugin spec into a deduped, valid list. */
export function parseToolPluginList(raw: string): ToolPluginId[] {
  const t = raw.trim().toLowerCase();
  if (t === "" || t === "none") return [];
  if (t === "all") return [...ALL_TOOL_PLUGINS];
  const out = new Set<ToolPluginId>();
  for (const part of t.split(",")) {
    const p = part.trim();
    if (isToolPluginId(p)) out.add(p);
  }
  return [...out];
}

function readConfigToolPlugins(path = configPath()): ToolPluginId[] | undefined {
  try {
    const json = JSON.parse(readFileSync(path, "utf-8")) as {
      tool_plugins?: unknown;
    };
    if (Array.isArray(json.tool_plugins)) {
      return json.tool_plugins.filter(
        (s): s is ToolPluginId => typeof s === "string" && isToolPluginId(s),
      );
    }
  } catch {
    // missing/invalid config → treated as "no preference"
  }
  return undefined;
}

/**
 * Resolve the enabled tool-plugin set per the documented precedence.
 * Default is empty — tool plugins are opt-in.
 */
export function resolveEnabledToolPlugins(): ToolPluginId[] {
  const env = process.env["MCP_DEVICES_TOOL_PLUGINS"];
  if (env !== undefined) return parseToolPluginList(env);
  const fromConfig = readConfigToolPlugins();
  if (fromConfig !== undefined) return fromConfig;
  return [];
}
