import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "./context.js";

export interface ToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>, ctx: ToolContext, depth?: number) => Promise<unknown>;
}

const toolMap = new Map<string, ToolDefinition>();
const aliasMap = new Map<string, string>();
const aliasDefaultsMap = new Map<string, { canonical: string; defaults: Record<string, unknown> }>();

// Freeze flag — once set, no further tool registration is allowed.
// Alias registration remains open post-freeze for client-specific aliases in oninitialized.
let frozen = false;

// Dynamic tool registration: tools in hiddenTools are registered but not shown in getTools()
const hiddenTools = new Set<string>();

// Tracks modules explicitly disabled via device(action:'disable_module').
// Auto-enable will NOT re-enable these — only explicit enable_module clears this flag.
const manuallyDisabled = new Set<string>();

// Lazy module loaders: module name → loader function
const lazyModules = new Map<string, () => void>();

// Server reference for sending tool list change notifications
let notifyToolListChanged: (() => void) | null = null;

export function setToolListChangedNotifier(notifier: () => void): void {
  notifyToolListChanged = notifier;
}

/**
 * Freeze the registry to prevent further tool registration.
 * Called after all tools are registered during initialization.
 * Alias registration is still allowed post-freeze (needed for client-specific aliases).
 */
export function freezeRegistry(): void {
  frozen = true;
}

export function registerTools(defs: ToolDefinition[]): void {
  if (frozen) throw new Error("Registry is frozen. Cannot register tools after initialization.");
  for (const def of defs) {
    toolMap.set(def.tool.name, def);
  }
}

/** Register tools but hide them from getTools() until unhidden */
export function registerToolsHidden(defs: ToolDefinition[]): void {
  if (frozen) throw new Error("Registry is frozen. Cannot register tools after initialization.");
  for (const def of defs) {
    toolMap.set(def.tool.name, def);
    hiddenTools.add(def.tool.name);
  }
}

/** Unhide tools — makes them visible in getTools() and notifies client.
 *  Also clears manuallyDisabled flag so the module is eligible for auto-enable again. */
export function unhideTools(names: string[]): void {
  let changed = false;
  for (const n of names) {
    manuallyDisabled.delete(n);
    if (hiddenTools.delete(n)) changed = true;
  }
  if (changed && notifyToolListChanged) {
    notifyToolListChanged();
  }
}

/** Hide tools — removes them from getTools(), marks as manually disabled, and notifies client */
export function hideTools(names: string[]): void {
  let changed = false;
  for (const n of names) {
    if (toolMap.has(n)) {
      hiddenTools.add(n);
      manuallyDisabled.add(n);
      changed = true;
    }
  }
  if (changed && notifyToolListChanged) {
    notifyToolListChanged();
  }
}

/** Register a lazy module that can be loaded on demand */
export function registerLazyModule(name: string, loader: () => void): void {
  lazyModules.set(name, loader);
}

/** Load a lazy module by name, returns true if loaded */
export function loadModule(name: string): boolean {
  const loader = lazyModules.get(name);
  if (!loader) return false;
  loader();
  lazyModules.delete(name);
  return true;
}

/** Get list of available modules and their status */
export function getModuleStatus(): Array<{ name: string; status: "loaded" | "available" }> {
  const result: Array<{ name: string; status: "loaded" | "available" }> = [];
  // Check which meta tools are visible (loaded) vs hidden (available)
  for (const [name] of toolMap) {
    if (hiddenTools.has(name)) {
      result.push({ name, status: "available" });
    }
  }
  // Pending lazy modules
  for (const [name] of lazyModules) {
    result.push({ name, status: "available" });
  }
  return result;
}

/** Reset all registry state — for test isolation */
export function resetRegistry(): void {
  toolMap.clear();
  aliasMap.clear();
  aliasDefaultsMap.clear();
  hiddenTools.clear();
  manuallyDisabled.clear();
  lazyModules.clear();
  notifyToolListChanged = null;
  frozen = false;
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

/** Returns a Set of all resolvable names: tools, simple aliases, and aliases with defaults. */
export function getRegisteredToolNames(): Set<string> {
  const names = new Set(toolMap.keys());
  for (const alias of aliasMap.keys()) names.add(alias);
  for (const alias of aliasDefaultsMap.keys()) names.add(alias);
  return names;
}

export function getTools(): Tool[] {
  return [...toolMap.values()]
    .filter(d => !hiddenTools.has(d.tool.name))
    .map(d => d.tool);
}

export interface ResolvedToolCall {
  handler: ToolDefinition["handler"];
  args: Record<string, unknown>;
  /** Name of the module that was auto-enabled, or null if no auto-enable occurred */
  autoEnabled: string | null;
}

/**
 * Auto-enable a hidden tool if it is not manually disabled.
 * Returns the tool name if auto-enabled, null otherwise.
 */
function tryAutoEnable(toolName: string): string | null {
  if (hiddenTools.has(toolName) && !manuallyDisabled.has(toolName)) {
    unhideTools([toolName]);
    return toolName;
  }
  return null;
}

export function resolveToolCall(
  name: string,
  args: Record<string, unknown>,
): ResolvedToolCall | undefined {
  // Direct tool match
  const direct = toolMap.get(name);
  if (direct) {
    const autoEnabled = tryAutoEnable(name);
    return { handler: direct.handler, args, autoEnabled };
  }

  // Simple alias (no default args) — also resolves chains (alias -> aliasWithDefaults -> tool)
  const canonical = aliasMap.get(name);
  if (canonical) {
    const def = toolMap.get(canonical);
    if (def) {
      const autoEnabled = tryAutoEnable(canonical);
      return { handler: def.handler, args, autoEnabled };
    }
    // Chain: simple alias -> aliasWithDefaults -> tool
    const chained = aliasDefaultsMap.get(canonical);
    if (chained) {
      const chainedDef = toolMap.get(chained.canonical);
      if (chainedDef) {
        const autoEnabled = tryAutoEnable(chained.canonical);
        return { handler: chainedDef.handler, args: { ...chained.defaults, ...args }, autoEnabled };
      }
    }
  }

  // Alias with default args (defaults are overridden by explicit args)
  const withDefaults = aliasDefaultsMap.get(name);
  if (withDefaults) {
    const def = toolMap.get(withDefaults.canonical);
    if (def) {
      const autoEnabled = tryAutoEnable(withDefaults.canonical);
      return { handler: def.handler, args: { ...withDefaults.defaults, ...args }, autoEnabled };
    }
  }

  return undefined;
}
