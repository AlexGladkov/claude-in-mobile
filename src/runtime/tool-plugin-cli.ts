import {
  ALL_TOOL_PLUGINS,
  isToolPluginId,
  parseToolPluginList,
  resolveEnabledToolPlugins,
  writeEnabledToolPlugins,
} from "./tool-plugin-config.js";
import type { ToolPluginId } from "./tool-plugin-config.js";
import { sanitizeErrorMessage } from "../utils/sanitize.js";

export function applyToolPluginEnable(
  current: readonly ToolPluginId[],
  args: readonly string[],
): ToolPluginId[] {
  const additions = args.flatMap(parseToolPluginList);
  return [...new Set([...current, ...additions])];
}

export function applyToolPluginDisable(
  current: readonly ToolPluginId[],
  args: readonly string[],
): ToolPluginId[] {
  const removals = new Set(args.flatMap(parseToolPluginList));
  return current.filter((plugin) => !removals.has(plugin));
}

function invalidToolPlugin(args: readonly string[]): string | undefined {
  for (const raw of args) {
    for (const token of raw.toLowerCase().split(",").map((value) => value.trim())) {
      if (token !== "all" && !isToolPluginId(token)) return token;
    }
  }
  return undefined;
}

function printToolPlugins(): void {
  const enabled = resolveEnabledToolPlugins();
  console.log(`Enabled tool plugins:   ${enabled.join(", ") || "none"}`);
  console.log(`Available tool plugins: ${ALL_TOOL_PLUGINS.join(", ")}`);
  console.log("Enable with: mcp-devices plugin enable <plugin|all>");
}

export function runToolPluginCommand(
  argv: readonly string[],
  exit: (code: number) => never = process.exit,
): boolean {
  const command = argv[2];
  if (command === "plugins") {
    printToolPlugins();
    return exit(0);
  }
  if (command !== "plugin") return false;

  const action = argv[3];
  const requested = argv.slice(4);
  if (action === "list") {
    printToolPlugins();
    return exit(0);
  }
  if (action !== "enable" && action !== "disable") {
    console.error("Usage: mcp-devices plugin <list|enable|disable> [debug|all]...");
    return exit(1);
  }
  if (requested.length === 0) {
    console.error(`Usage: mcp-devices plugin ${action} <debug|all>...`);
    return exit(1);
  }
  const invalid = invalidToolPlugin(requested);
  if (invalid) {
    console.error(
      `Unknown tool plugin: ${sanitizeErrorMessage(invalid)}. Available: ${ALL_TOOL_PLUGINS.join(", ")}`,
    );
    return exit(1);
  }

  const current = resolveEnabledToolPlugins();
  const next = action === "enable"
    ? applyToolPluginEnable(current, requested)
    : applyToolPluginDisable(current, requested);
  writeEnabledToolPlugins(next);
  console.log(`Enabled tool plugins: ${next.join(", ") || "none"}`);
  console.log("Restart your MCP client (or server) to apply.");
  return exit(0);
}
