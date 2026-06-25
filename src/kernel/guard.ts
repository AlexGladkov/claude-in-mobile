import {
  CapabilityMissingError,
  type Capability,
  type SourcePlugin,
} from "@mcp-devices/plugin-api";

export function requireCapability(plugin: SourcePlugin, cap: Capability): void {
  if (!plugin.manifest.capabilities.includes(cap)) {
    throw new CapabilityMissingError(plugin.manifest.id, cap);
  }
}

export function requireAll(plugin: SourcePlugin, caps: readonly Capability[]): void {
  for (const c of caps) requireCapability(plugin, c);
}

export function hasAll(plugin: SourcePlugin, caps: readonly Capability[]): boolean {
  return caps.every((c) => plugin.manifest.capabilities.includes(c));
}
