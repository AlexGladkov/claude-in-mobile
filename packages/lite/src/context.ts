/**
 * Lite DeviceManager factory — 3 adapters only (Android, iOS, Desktop).
 * No Aurora, no Browser. Minimal memory footprint.
 */

import { DeviceManager } from "claude-in-mobile/device-manager";
import { AndroidAdapter } from "claude-in-mobile/adapters/android-adapter";
import { IosAdapter } from "claude-in-mobile/adapters/ios-adapter";
import { DesktopAdapter } from "claude-in-mobile/adapters/desktop-adapter";
import { AdbClient } from "claude-in-mobile/adb/client";
import { IosClient } from "claude-in-mobile/ios/client";
import type { Platform } from "claude-in-mobile/device-manager";
import type { CorePlatformAdapter } from "claude-in-mobile/adapters/platform-adapter";

export function createLiteDeviceManager(): DeviceManager {
  const androidDeviceId = process.env.DEVICE_ID ?? process.env.ANDROID_SERIAL ?? undefined;
  const iosDeviceId = process.env.IOS_DEVICE_ID ?? undefined;

  const androidAdapter = androidDeviceId
    ? new AndroidAdapter(new AdbClient(androidDeviceId))
    : new AndroidAdapter();

  const iosAdapter = iosDeviceId
    ? new IosAdapter(new IosClient(iosDeviceId))
    : new IosAdapter();

  const desktopAdapter = new DesktopAdapter();

  const adapters = new Map<Platform, CorePlatformAdapter>([
    ["android", androidAdapter],
    ["ios", iosAdapter],
    ["desktop", desktopAdapter],
  ]);

  let activeTarget: Platform = "android";
  if (androidDeviceId) activeTarget = "android";
  else if (iosDeviceId) activeTarget = "ios";

  return new DeviceManager({ adapters, activeTarget });
}
