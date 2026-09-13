/**
 * Lite kernel factory — Android, iOS, and Desktop only.
 * No Aurora or Browser plugins.
 */

import type { SourcePlugin } from "@mcp-devices/plugin-api";
import { DeviceManager } from "mcp-devices/device-manager";
import type { Platform } from "mcp-devices/device-manager";
import type { CorePlatformAdapter } from "mcp-devices/adapters/platform-adapter";
import { bootstrapKernelAsync } from "mcp-devices/runtime/bootstrap";
import type { KernelHandle } from "mcp-devices/runtime/bootstrap";

type AdapterPlugin = SourcePlugin & {
  readonly adapter: CorePlatformAdapter;
};

export interface LiteDeviceContext {
  readonly deviceManager: DeviceManager;
  dispose(): Promise<void>;
}

export async function createLiteDeviceContext(): Promise<LiteDeviceContext> {
  const androidDeviceId = process.env.DEVICE_ID ?? process.env.ANDROID_SERIAL;
  const iosDeviceId = process.env.IOS_DEVICE_ID;
  const activeTarget: Platform = iosDeviceId && !androidDeviceId ? "ios" : "android";
  const kernel: KernelHandle = await bootstrapKernelAsync({
    platforms: ["android", "ios", "desktop"],
  });

  await kernel.initAll();
  if (androidDeviceId) {
    kernel.getPlugin<AdapterPlugin>("android")?.adapter.selectDevice(androidDeviceId);
  }
  if (iosDeviceId) {
    kernel.getPlugin<AdapterPlugin>("ios")?.adapter.selectDevice(iosDeviceId);
  }

  return {
    deviceManager: DeviceManager.fromKernel(kernel, activeTarget),
    dispose: () => kernel.disposeAll(),
  };
}
