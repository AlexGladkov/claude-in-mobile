import {
  readRuntimeConfig,
  runtimeConfigPath,
  updateRuntimeConfig,
} from "./config-file.js";

function parseBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return undefined;
}

export function resolveExternalPlugins(): boolean {
  const env = process.env.MCP_DEVICES_EXTERNAL_PLUGINS;
  if (env !== undefined) return parseBoolean(env) ?? false;
  return readRuntimeConfig().external_plugins === true;
}

export function writeExternalPlugins(
  enabled: boolean,
  path = runtimeConfigPath(),
): void {
  updateRuntimeConfig({ external_plugins: enabled }, path);
}