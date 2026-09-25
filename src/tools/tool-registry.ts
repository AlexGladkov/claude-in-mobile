import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition, EnrichedModuleStatus } from "./registry-types.js";
import type { ModuleCategory, ModuleMeta } from "../profiles.js";

/**
 * ToolRegistry — encapsulates the previously module-level mutable state of
 * the tool registry (toolMap / aliasMap / frozen flag / listeners / …).
 *
 * Behaviour is identical to the legacy module-level implementation; the
 * top-level functions in `registry.ts` now delegate here via the default
 * RuntimeContext.
 */
export class ToolRegistry {
  private readonly toolMap = new Map<string, ToolDefinition>();
  private readonly toolOwners = new Map<string, string>();
  private readonly aliasMap = new Map<string, string>();
  private readonly aliasDefaultsMap = new Map<
    string,
    { canonical: string; defaults: Record<string, unknown> }
  >();
  private frozen = false;
  private readonly hiddenTools = new Set<string>();
  private readonly manuallyDisabled = new Set<string>();
  private readonly lazyModules = new Map<string, () => void>();
  private readonly moduleMetadataMap = new Map<string, ModuleMeta>();
  private notifyToolListChanged: (() => void) | null = null;

  setToolListChangedNotifier(notifier: () => void): void {
    this.notifyToolListChanged = notifier;
  }

  freezeRegistry(): void {
    this.frozen = true;
  }

  assertToolsAvailable(names: readonly string[], owner: string): void {
    const staged = new Set<string>();
    for (const rawName of names) {
      const name = rawName.trim();
      if (!name || name !== rawName) {
        throw new Error(
          `Tool name from '${owner}' must be non-empty and have no surrounding whitespace.`,
        );
      }
      if (staged.has(name)) {
        throw new Error(`Tool '${name}' is registered twice by '${owner}'.`);
      }
      staged.add(name);
      if (this.aliasMap.has(name) || this.aliasDefaultsMap.has(name)) {
        throw new Error(`Tool '${name}' from '${owner}' conflicts with an existing alias.`);
      }
      const existingOwner = this.toolOwners.get(name);
      if (existingOwner && existingOwner !== owner) {
        throw new Error(
          `Tool '${name}' from '${owner}' conflicts with owner '${existingOwner}'.`,
        );
      }
    }
  }

  registerTools(defs: ToolDefinition[], owner = "legacy"): void {
    this.registerBatch(defs, owner, false);
  }

  registerToolsHidden(defs: ToolDefinition[], owner = "legacy"): void {
    this.registerBatch(defs, owner, true);
  }

  private registerBatch(defs: ToolDefinition[], owner: string, hidden: boolean): void {
    if (this.frozen) {
      throw new Error("Registry is frozen. Cannot register tools after initialization.");
    }
    const names = defs.map((def) => def.tool.name);
    this.assertToolsAvailable(names, owner);
    for (const def of defs) {
      const name = def.tool.name;
      this.toolMap.set(name, def);
      this.toolOwners.set(name, owner);
      if (hidden) this.hiddenTools.add(name);
    }
  }

  unhideTools(names: string[]): void {
    let changed = false;
    for (const n of names) {
      this.manuallyDisabled.delete(n);
      if (this.hiddenTools.delete(n)) changed = true;
    }
    if (changed && this.notifyToolListChanged) this.notifyToolListChanged();
  }

  hideTools(names: string[]): void {
    let changed = false;
    for (const n of names) {
      if (this.toolMap.has(n)) {
        this.hiddenTools.add(n);
        this.manuallyDisabled.add(n);
        changed = true;
      }
    }
    if (changed && this.notifyToolListChanged) this.notifyToolListChanged();
  }

  registerLazyModule(name: string, loader: () => void): void {
    this.lazyModules.set(name, loader);
  }

  loadModule(name: string): boolean {
    const loader = this.lazyModules.get(name);
    if (!loader) return false;
    loader();
    this.lazyModules.delete(name);
    return true;
  }

  registerAllModuleMetadata(modules: readonly ModuleMeta[]): void {
    for (const m of modules) this.moduleMetadataMap.set(m.name, m);
  }

  getModuleMetadata(name: string): ModuleMeta | undefined {
    return this.moduleMetadataMap.get(name);
  }

  unhideByCategory(category: ModuleCategory): string[] {
    const names: string[] = [];
    for (const [name, meta] of this.moduleMetadataMap) {
      if (meta.category === category && this.hiddenTools.has(name)) names.push(name);
    }
    if (names.length > 0) this.unhideTools(names);
    return names;
  }

  hideByCategory(category: ModuleCategory, alwaysVisible: readonly string[]): string[] {
    const names: string[] = [];
    for (const [name, meta] of this.moduleMetadataMap) {
      if (
        meta.category === category &&
        !alwaysVisible.includes(name) &&
        !this.hiddenTools.has(name)
      ) {
        names.push(name);
      }
    }
    if (names.length > 0) this.hideTools(names);
    return names;
  }

  getModuleStatus(): EnrichedModuleStatus[] {
    const result: EnrichedModuleStatus[] = [];

    for (const [name, meta] of this.moduleMetadataMap) {
      const inRegistry = this.toolMap.has(name);
      const isHidden = this.hiddenTools.has(name);
      const isDisabled = this.manuallyDisabled.has(name);

      let status: EnrichedModuleStatus["status"];
      if (!inRegistry && !this.lazyModules.has(name)) status = "available";
      else if (isDisabled) status = "disabled";
      else if (isHidden) status = "available";
      else if (inRegistry) status = "loaded";
      else status = "available";

      result.push({
        name,
        status,
        description: meta.description,
        category: meta.category,
        actions: meta.actions,
      });
    }

    for (const name of this.hiddenTools) {
      if (!this.moduleMetadataMap.has(name)) {
        result.push({
          name,
          status: this.manuallyDisabled.has(name) ? "disabled" : "available",
        });
      }
    }

    for (const [name] of this.lazyModules) {
      if (!this.moduleMetadataMap.has(name) && !this.hiddenTools.has(name)) {
        result.push({ name, status: "available" });
      }
    }

    return result;
  }

  reset(): void {
    this.toolMap.clear();
    this.toolOwners.clear();
    this.aliasMap.clear();
    this.aliasDefaultsMap.clear();
    this.hiddenTools.clear();
    this.manuallyDisabled.clear();
    this.lazyModules.clear();
    this.moduleMetadataMap.clear();
    this.notifyToolListChanged = null;
    this.frozen = false;
  }

  registerAliases(aliases: Record<string, string>): void {
    this.assertAliasNamesAvailable(Object.keys(aliases));
    for (const [alias, canonical] of Object.entries(aliases)) {
      this.aliasMap.set(alias, canonical);
    }
  }

  registerAliasesWithDefaults(
    aliases: Record<string, { tool: string; defaults: Record<string, unknown> }>,
  ): void {
    this.assertAliasNamesAvailable(Object.keys(aliases));
    for (const [alias, entry] of Object.entries(aliases)) {
      this.aliasDefaultsMap.set(alias, { canonical: entry.tool, defaults: entry.defaults });
    }
  }

  private assertAliasNamesAvailable(names: readonly string[]): void {
    for (const alias of names) {
      const owner = this.toolOwners.get(alias);
      if (owner) {
        throw new Error(`Alias '${alias}' conflicts with tool owned by '${owner}'.`);
      }
    }
  }

  getRegisteredToolNames(): Set<string> {
    const names = new Set(this.toolMap.keys());
    for (const alias of this.aliasMap.keys()) names.add(alias);
    for (const alias of this.aliasDefaultsMap.keys()) names.add(alias);
    return names;
  }

  getTools(): Tool[] {
    return [...this.toolMap.values()]
      .filter(d => !this.hiddenTools.has(d.tool.name))
      .map(d => d.tool);
  }

  private tryAutoEnable(toolName: string): string | null {
    if (this.hiddenTools.has(toolName) && !this.manuallyDisabled.has(toolName)) {
      this.unhideTools([toolName]);
      return toolName;
    }
    return null;
  }

  /**
   * Resolve a tool name and its alias defaults without invoking the handler or
   * auto-enabling a hidden module. Flow validation uses this pure identity so
   * aliases cannot evade canonical safety checks.
   */
  resolveToolIdentity(
    name: string,
    args: Record<string, unknown> = {},
  ):
    | {
        canonical: string;
        args: Record<string, unknown>;
      }
    | undefined {
    let current = name;
    let resolvedArgs = { ...args };
    const seen = new Set<string>();

    while (!this.toolMap.has(current)) {
      if (seen.has(current)) return undefined;
      seen.add(current);

      const alias = this.aliasMap.get(current);
      if (alias !== undefined) {
        current = alias;
        continue;
      }

      const withDefaults = this.aliasDefaultsMap.get(current);
      if (withDefaults) {
        resolvedArgs = { ...withDefaults.defaults, ...resolvedArgs };
        current = withDefaults.canonical;
        continue;
      }

      return undefined;
    }

    return { canonical: current, args: resolvedArgs };
  }

  resolveToolCall(
    name: string,
    args: Record<string, unknown>,
  ):
    | {
        handler: ToolDefinition["handler"];
        args: Record<string, unknown>;
        autoEnabled: string | null;
      }
    | undefined {
    const identity = this.resolveToolIdentity(name, args);
    if (!identity) return undefined;

    const def = this.toolMap.get(identity.canonical);
    if (!def) return undefined;

    const autoEnabled = this.tryAutoEnable(identity.canonical);
    return { handler: def.handler, args: identity.args, autoEnabled };
  }
}
