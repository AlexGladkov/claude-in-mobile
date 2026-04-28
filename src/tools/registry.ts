import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "./context.js";
import type { ModuleCategory, ModuleMeta } from "../profiles.js";

export interface ToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>, ctx: ToolContext, depth?: number) => Promise<unknown>;
}

export interface EnrichedModuleStatus {
  name: string;
  status: "loaded" | "available" | "disabled";
  description?: string;
  category?: ModuleCategory;
  actions?: string[];
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

// Module metadata registry
const moduleMetadataMap = new Map<string, ModuleMeta>();

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

/** Register metadata for all modules (called once at startup) */
export function registerAllModuleMetadata(modules: readonly ModuleMeta[]): void {
  for (const m of modules) {
    moduleMetadataMap.set(m.name, m);
  }
}

/** Get metadata for a single module */
export function getModuleMetadata(name: string): ModuleMeta | undefined {
  return moduleMetadataMap.get(name);
}

/** Unhide all hideable modules in a category */
export function unhideByCategory(category: ModuleCategory): string[] {
  const names: string[] = [];
  for (const [name, meta] of moduleMetadataMap) {
    if (meta.category === category && hiddenTools.has(name)) {
      names.push(name);
    }
  }
  if (names.length > 0) unhideTools(names);
  return names;
}

/** Hide all hideable modules in a category (skips always-visible) */
export function hideByCategory(category: ModuleCategory, alwaysVisible: readonly string[]): string[] {
  const names: string[] = [];
  for (const [name, meta] of moduleMetadataMap) {
    if (meta.category === category && !alwaysVisible.includes(name) && !hiddenTools.has(name)) {
      names.push(name);
    }
  }
  if (names.length > 0) hideTools(names);
  return names;
}

/** Get list of available modules and their status (enriched with metadata) */
export function getModuleStatus(): EnrichedModuleStatus[] {
  const result: EnrichedModuleStatus[] = [];

  // All registered tools that have metadata
  for (const [name, meta] of moduleMetadataMap) {
    const inRegistry = toolMap.has(name);
    const isHidden = hiddenTools.has(name);
    const isDisabled = manuallyDisabled.has(name);

    let status: EnrichedModuleStatus["status"];
    if (!inRegistry && !lazyModules.has(name)) {
      status = "available"; // known from metadata but not registered
    } else if (isDisabled) {
      status = "disabled";
    } else if (isHidden) {
      status = "available";
    } else if (inRegistry) {
      status = "loaded";
    } else {
      status = "available";
    }

    result.push({
      name,
      status,
      description: meta.description,
      category: meta.category,
      actions: meta.actions,
    });
  }

  // Hidden tools without metadata (legacy fallback)
  for (const name of hiddenTools) {
    if (!moduleMetadataMap.has(name)) {
      result.push({
        name,
        status: manuallyDisabled.has(name) ? "disabled" : "available",
      });
    }
  }

  // Pending lazy modules without metadata
  for (const [name] of lazyModules) {
    if (!moduleMetadataMap.has(name) && !hiddenTools.has(name)) {
      result.push({ name, status: "available" });
    }
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
  moduleMetadataMap.clear();
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
