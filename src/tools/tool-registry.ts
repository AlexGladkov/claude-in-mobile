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

  registerTools(defs: ToolDefinition[]): void {
    if (this.frozen)
      throw new Error("Registry is frozen. Cannot register tools after initialization.");
    for (const def of defs) this.toolMap.set(def.tool.name, def);
  }

  registerToolsHidden(defs: ToolDefinition[]): void {
    if (this.frozen)
      throw new Error("Registry is frozen. Cannot register tools after initialization.");
    for (const def of defs) {
      this.toolMap.set(def.tool.name, def);
      this.hiddenTools.add(def.tool.name);
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
    for (const [alias, canonical] of Object.entries(aliases)) {
      this.aliasMap.set(alias, canonical);
    }
  }

  registerAliasesWithDefaults(
    aliases: Record<string, { tool: string; defaults: Record<string, unknown> }>,
  ): void {
    for (const [alias, entry] of Object.entries(aliases)) {
      this.aliasDefaultsMap.set(alias, { canonical: entry.tool, defaults: entry.defaults });
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
    const direct = this.toolMap.get(name);
    if (direct) {
      const autoEnabled = this.tryAutoEnable(name);
      return { handler: direct.handler, args, autoEnabled };
    }

    const canonical = this.aliasMap.get(name);
    if (canonical) {
      const def = this.toolMap.get(canonical);
      if (def) {
        const autoEnabled = this.tryAutoEnable(canonical);
        return { handler: def.handler, args, autoEnabled };
      }
      const chained = this.aliasDefaultsMap.get(canonical);
      if (chained) {
        const chainedDef = this.toolMap.get(chained.canonical);
        if (chainedDef) {
          const autoEnabled = this.tryAutoEnable(chained.canonical);
          return {
            handler: chainedDef.handler,
            args: { ...chained.defaults, ...args },
            autoEnabled,
          };
        }
      }
    }

    const withDefaults = this.aliasDefaultsMap.get(name);
    if (withDefaults) {
      const def = this.toolMap.get(withDefaults.canonical);
      if (def) {
        const autoEnabled = this.tryAutoEnable(withDefaults.canonical);
        return {
          handler: def.handler,
          args: { ...withDefaults.defaults, ...args },
          autoEnabled,
        };
      }
    }

    return undefined;
  }
}
