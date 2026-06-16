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
import { AndroidAdapter } from "../adapters/android-adapter.js";
import { IosAdapter } from "../adapters/ios-adapter.js";
import { DesktopAdapter } from "../adapters/desktop-adapter.js";
import { BrowserAdapter } from "../adapters/browser-adapter.js";
import { AdbClient } from "../adb/client.js";
import { IosClient } from "../ios/client.js";
import type { Platform } from "../platform-types.js";

export interface DefaultAdapters {
  adapters: Map<Platform, CorePlatformAdapter>;
  envSeededTarget?: Platform;
}

/**
 * Build the default 4-platform adapter map (android, ios, desktop, aurora,
 * browser). Honours DEVICE_ID/ANDROID_SERIAL/IOS_DEVICE_ID env vars.
 */
export function buildDefaultAdapters(): DefaultAdapters {
  const androidDeviceId = process.env.DEVICE_ID ?? process.env.ANDROID_SERIAL ?? undefined;
  const iosDeviceId = process.env.IOS_DEVICE_ID ?? undefined;

  const androidAdapter = androidDeviceId
    ? new AndroidAdapter(new AdbClient(androidDeviceId))
    : new AndroidAdapter();

  const iosAdapter = iosDeviceId
    ? new IosAdapter(new IosClient(iosDeviceId))
    : new IosAdapter();

  const desktopAdapter = new DesktopAdapter();
  const browserAdapter = new BrowserAdapter();

  // Aurora is delivered as a separate package (@claude-in-mobile/plugin-aurora)
  // and wired through the kernel, not this legacy eager map.
  const adapters = new Map<Platform, CorePlatformAdapter>([
    ["android", androidAdapter],
    ["ios", iosAdapter],
    ["desktop", desktopAdapter],
    ["browser", browserAdapter],
  ]);

  let envSeededTarget: Platform | undefined;
  if (androidDeviceId) {
    envSeededTarget = "android";
  } else if (iosDeviceId) {
    envSeededTarget = "ios";
  }

  return { adapters, envSeededTarget };
}
