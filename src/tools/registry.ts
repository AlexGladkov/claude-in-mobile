import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "./context.js";

export interface ToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>, ctx: ToolContext, depth?: number) => Promise<unknown>;
}

const toolMap = new Map<string, ToolDefinition>();
const aliasMap = new Map<string, string>();
const aliasDefaultsMap = new Map<string, { canonical: string; defaults: Record<string, unknown> }>();

export function registerTools(defs: ToolDefinition[]): void {
  for (const def of defs) {
    toolMap.set(def.tool.name, def);
  }
}

export function registerAliases(aliases: Record<string, string>): void {
  for (const [alias, canonical] of Object.entries(aliases)) {
    aliasMap.set(alias, canonical);
  }
}

export function registerAliasesWithDefaults(
  aliases: Record<string, { tool: string; defaults: Record<string, unknown> }>,
): void {
  for (const [alias, entry] of Object.entries(aliases)) {
    aliasDefaultsMap.set(alias, { canonical: entry.tool, defaults: entry.defaults });
  }
}

export function getTools(): Tool[] {
  return [...toolMap.values()].map(d => d.tool);
}

export function resolveToolCall(
  name: string,
  args: Record<string, unknown>,
): { handler: ToolDefinition["handler"]; args: Record<string, unknown> } | undefined {
  // Direct tool match
  const direct = toolMap.get(name);
  if (direct) return { handler: direct.handler, args };

  // Simple alias (no default args)
  const canonical = aliasMap.get(name);
  if (canonical) {
    const def = toolMap.get(canonical);
    if (def) return { handler: def.handler, args };
  }

  // Alias with default args (defaults are overridden by explicit args)
  const withDefaults = aliasDefaultsMap.get(name);
  if (withDefaults) {
    const def = toolMap.get(withDefaults.canonical);
    if (def) return { handler: def.handler, args: { ...withDefaults.defaults, ...args } };
  }

  return undefined;
}
