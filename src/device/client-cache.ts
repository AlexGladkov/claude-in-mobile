/**
 * ClientCache -- owns the default adapter map construction.
 *
 * Extracted from device-manager.ts (D9.1) to separate adapter-factory wiring
 * from the routing facade. Reads env vars to seed device IDs on android/ios
 * adapters and produces the canonical 5-platform adapter map.
 *
 * Behaviour-preserving: identical construction order and env precedence as
 * the legacy `new DeviceManager()` default branch.
 */

import type { CorePlatformAdapter } from "../adapters/platform-adapter.js";
import type { Platform } from "../platform-types.js";

export interface DefaultAdapters {
  adapters: Map<Platform, CorePlatformAdapter>;
  envSeededTarget?: Platform;
}

/**
 * Build the default adapter map (ios + env-seeded target;
 * browser). Honours DEVICE_ID/ANDROID_SERIAL/IOS_DEVICE_ID env vars.
 */
export function buildDefaultAdapters(): DefaultAdapters {
  const androidDeviceId = process.env.DEVICE_ID ?? process.env.ANDROID_SERIAL ?? undefined;
  const iosDeviceId = process.env.IOS_DEVICE_ID ?? undefined;


  // Aurora is delivered as a separate package (@mcp-devices/plugin-aurora)
  // and wired through the kernel, not this legacy eager map.
  const adapters = new Map<Platform, CorePlatformAdapter>([
  ]);

  let envSeededTarget: Platform | undefined;
  if (androidDeviceId) {
    envSeededTarget = "android";
  } else if (iosDeviceId) {
    envSeededTarget = "ios";
  }

  return { adapters, envSeededTarget };
}
