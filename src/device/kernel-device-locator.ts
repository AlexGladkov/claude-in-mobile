/**
 * KernelDeviceLocator -- bridge from microkernel plugin registry to the
 * legacy CorePlatformAdapter map used by DeviceManager.
 *
 * Extracted from device-manager.ts (D9.1). The structural KernelHandleView
 * type lives here so device-manager doesn't have to know about plugins/**
 * (preserves ADR 0001 layering: the facade must not statically depend on
 * plugin modules).
 */

import type {
  Capability,
  PluginPlatformAdapter,
} from "@mcp-devices/plugin-api";
import {
  setAdapterCapabilities,
} from "../adapters/platform-adapter.js";
import type { CorePlatformAdapter } from "../adapters/platform-adapter.js";
import type { Platform } from "../platform-types.js";
/**
 * Structural view of the microkernel handle used by `DeviceManager.fromKernel`.
 * Defined structurally so device-manager.ts does NOT import from `plugins/**`
 * -- preserves the layering rule from ADR 0001 (plugins must not import the
 * legacy facade, and the facade must not statically depend on plugin modules).
 */
export interface KernelHandleView {
  registry: {
    list(): readonly {
      state: string;
      plugin: {
        manifest: { id: string; capabilities?: readonly Capability[] };
        /** Public plugin-api contract; host adapters are intentionally not required. */
        adapter?: PluginPlatformAdapter;
      };
    }[];
  };
}

const PLATFORM_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const BUILTIN_PLATFORM_IDS = [
  "android",
  "ios",
  "desktop",
  "aurora",
  "harmony",
  "browser",
] as const;

const CORE_ADAPTER_METHODS = [
  "listDevices",
  "selectDevice",
  "getSelectedDeviceId",
  "autoDetectDevice",
  "tap",
  "doubleTap",
  "longPress",
  "swipe",
  "swipeDirection",
  "inputText",
  "pressKey",
  "screenshotAsync",
  "getScreenshotBufferAsync",
  "getSystemInfo",
] as const;

const CAPABILITY_METHODS: Partial<Record<Capability, readonly string[]>> = {
  screen: ["screenshotAsync", "getScreenshotBufferAsync"],
  input: [
    "tap",
    "doubleTap",
    "longPress",
    "swipe",
    "swipeDirection",
    "inputText",
    "pressKey",
  ],
  shell: ["shell"],
  logs: ["getLogs", "clearLogs"],
  appLifecycle: ["launchApp", "stopApp", "installApp"],
  permissions: ["grantPermission", "revokePermission", "resetPermissions"],
  fileTransfer: ["pushFile", "pullFile"],
  url: ["openUrl"],
  deviceMgmt: [
    "listDevices",
    "selectDevice",
    "getSelectedDeviceId",
    "autoDetectDevice",
  ],
};

function hasFunction(value: object, key: string): boolean {
  return typeof Reflect.get(value, key) === "function";
}

function isCorePlatformAdapter(
  adapter: PluginPlatformAdapter,
): adapter is CorePlatformAdapter {
  return CORE_ADAPTER_METHODS.every((method) => hasFunction(adapter, method));
}

function validateAdvertisedCapabilities(
  adapter: PluginPlatformAdapter,
  manifest: { id: string; capabilities?: readonly Capability[] },
): void {
  const capabilities = manifest.capabilities ?? [];
  const isBuiltinPlatform = BUILTIN_PLATFORM_IDS.some((id) => id === adapter.platform);
  for (const capability of capabilities) {
    const required = CAPABILITY_METHODS[capability];
    if (required && !required.every((method) => hasFunction(adapter, method))) {
      const missing = required.filter((method) => !hasFunction(adapter, method));
      throw new Error(
        `[plugin:${manifest.id}] adapter is missing ${capability} method(s): ${missing.join(", ")}.`,
      );
    }
    if (capability !== "ui") continue;
    if (isBuiltinPlatform && !hasFunction(adapter, "getUiHierarchy")) {
      throw new Error(
        `[plugin:${manifest.id}] built-in ui capability requires getUiHierarchy().`,
      );
    }
    if (!isBuiltinPlatform && !hasFunction(adapter, "getUiElements")) {
      throw new Error(
        `[plugin:${manifest.id}] external ui capability requires getUiElements().`,
      );
    }
  }
}

/**
 * Collect adapters from a kernel handle into a Platform→adapter map.
 *
 * Plugins that expose an `adapter` field contribute one adapter under the
 * adapter's platform id. Plugin ids may name the delivery package instead
 * (`web`) while the public platform remains `browser`.
 */
export function adaptersFromKernel(
  handle: KernelHandleView,
): Map<Platform, CorePlatformAdapter> {
  const adapters = new Map<Platform, CorePlatformAdapter>();
  for (const entry of handle.registry.list()) {
    const adapter = entry.plugin.adapter;
    if (entry.state !== "active" || !adapter) continue;

    const platform = adapter.platform;
    if (typeof platform !== "string" || !PLATFORM_ID_RE.test(platform)) {
      throw new Error(`Invalid plugin adapter platform '${String(platform)}'.`);
    }
    if (!isCorePlatformAdapter(adapter)) {
      throw new Error(
        `[plugin:${entry.plugin.manifest.id}] adapter does not implement the public core contract.`,
      );
    }
    validateAdvertisedCapabilities(adapter, entry.plugin.manifest);
    if (adapters.has(platform as Platform)) {
      throw new Error(`Duplicate active plugin adapter platform '${platform}'.`);
    }

    setAdapterCapabilities(adapter, entry.plugin.manifest.capabilities ?? []);
    adapters.set(platform as Platform, adapter);
  }
  return adapters;
}
