/**
 * ScreenProxy — screenshot + UI hierarchy ops.
 *
 * Extracted from DeviceManager (D9.1b). screenshot/getScreenshotBuffer
 * keep their "alias of *Async" shape so the public surface is unchanged.
 */

import { hasRawUiHierarchy, hasScreen, hasSyncScreenshot } from "../../adapters/platform-adapter.js";
import type { Platform } from "../../platform-types.js";
import type { CompressOptions } from "../../utils/image.js";
import type { AdapterResolver } from "./input-proxy.js";

function requireScreen(
  resolve: AdapterResolver,
  platform: Platform | undefined,
  deviceId: string | undefined,
) {
  const adapter = resolve(platform, deviceId);
  if (!(hasScreen(adapter) as boolean)) {
    throw new Error(`Screen is not supported for ${adapter.platform}.`);
  }
  return adapter;
}

function requireUiHierarchy(
  resolve: AdapterResolver,
  platform: Platform | undefined,
  deviceId: string | undefined,
) {
  const adapter = resolve(platform, deviceId);
  if (!hasRawUiHierarchy(adapter)) {
    throw new Error(`Raw UI hierarchy is not supported for ${adapter.platform}.`);
  }
  return adapter;
}
export class ScreenProxy {
  constructor(private readonly resolve: AdapterResolver) {}

  async screenshot(
    platform?: Platform,
    compress: boolean = true,
    options?: CompressOptions & { monitorIndex?: number },
    deviceId?: string,
  ): Promise<{ data: string; mimeType: string }> {
    return this.screenshotAsync(platform, compress, options, deviceId);
  }

  async getScreenshotBuffer(platform?: Platform, deviceId?: string): Promise<Buffer> {
    return this.getScreenshotBufferAsync(platform, deviceId);
  }

  screenshotRaw(platform?: Platform): string {
    const adapter = this.resolve(platform);
    if (!hasSyncScreenshot(adapter)) {
      throw new Error(`screenshotRaw is not supported for ${adapter.platform}. Use screenshotAsync.`);
    }
    return adapter.screenshotRaw();
  }

  async screenshotAsync(
    platform?: Platform,
    compress: boolean = true,
    options?: CompressOptions & { monitorIndex?: number },
    deviceId?: string,
  ): Promise<{ data: string; mimeType: string }> {
    const adapter = requireScreen(this.resolve, platform, deviceId);
    return adapter.screenshotAsync(compress, options, deviceId);
  }

  async getScreenshotBufferAsync(platform?: Platform, deviceId?: string): Promise<Buffer> {
    const adapter = requireScreen(this.resolve, platform, deviceId);
    return adapter.getScreenshotBufferAsync(deviceId);
  }

  async getUiHierarchy(platform?: Platform, deviceId?: string, turbo?: boolean): Promise<string> {
    const adapter = requireUiHierarchy(this.resolve, platform, deviceId);
    return adapter.getUiHierarchy(deviceId, turbo);
  }
}
