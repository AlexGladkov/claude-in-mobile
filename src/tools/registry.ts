/**
 * Module-level tool registry façade.
 *
 * State lives in `ToolRegistry` (see `./tool-registry.ts`); this module
 * provides the legacy top-level function API that delegates to the
 * default RuntimeContext singleton. This keeps every existing call site
 * (`registerTools`, `getTools`, `resolveToolCall`, …) working unchanged
 * while the underlying mutable state is owned by a single object.
 */

import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ModuleCategory, ModuleMeta } from "../profiles.js";
import { getDefaultRuntimeContext } from "../runtime/runtime-context.js";
import type { ToolDefinition, EnrichedModuleStatus } from "./registry-types.js";

export type { ToolDefinition, EnrichedModuleStatus } from "./registry-types.js";

function reg() {
  return getDefaultRuntimeContext().registry;
}

export function setToolListChangedNotifier(notifier: () => void): void {
  reg().setToolListChangedNotifier(notifier);
}

export function freezeRegistry(): void {
  reg().freezeRegistry();
}

export function registerTools(defs: ToolDefinition[]): void {
  reg().registerTools(defs);
}

export function registerToolsHidden(defs: ToolDefinition[]): void {
  reg().registerToolsHidden(defs);
}

export function unhideTools(names: string[]): void {
  reg().unhideTools(names);
}

export function hideTools(names: string[]): void {
  reg().hideTools(names);
}

export function registerLazyModule(name: string, loader: () => void): void {
  reg().registerLazyModule(name, loader);
}

export function loadModule(name: string): boolean {
  return reg().loadModule(name);
}

export function registerAllModuleMetadata(modules: readonly ModuleMeta[]): void {
  reg().registerAllModuleMetadata(modules);
}

export function getModuleMetadata(name: string): ModuleMeta | undefined {
  return reg().getModuleMetadata(name);
}

export function unhideByCategory(category: ModuleCategory): string[] {
  return reg().unhideByCategory(category);
}

export function hideByCategory(
  category: ModuleCategory,
  alwaysVisible: readonly string[],
): string[] {
  return reg().hideByCategory(category, alwaysVisible);
}

export function getModuleStatus(): EnrichedModuleStatus[] {
  return reg().getModuleStatus();
}

export function resetRegistry(): void {
  reg().reset();
}

export function registerAliases(aliases: Record<string, string>): void {
  reg().registerAliases(aliases);
}

export function registerAliasesWithDefaults(
  aliases: Record<string, { tool: string; defaults: Record<string, unknown> }>,
): void {
  reg().registerAliasesWithDefaults(aliases);
}

export function getRegisteredToolNames(): Set<string> {
  return reg().getRegisteredToolNames();
}

export function getTools(): Tool[] {
  return reg().getTools();
}

export interface ResolvedToolCall {
  handler: ToolDefinition["handler"];
  args: Record<string, unknown>;
  autoEnabled: string | null;
}

export function resolveToolCall(
  name: string,
  args: Record<string, unknown>,
): ResolvedToolCall | undefined {
  return reg().resolveToolCall(name, args);
}
