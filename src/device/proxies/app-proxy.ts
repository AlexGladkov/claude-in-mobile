/**
 * AppProxy — app management ops (launch/stop/install).
 *
 * Extracted from DeviceManager (D9.1b). Guards via hasAppManagement before
 * delegating; throws the same messages DeviceManager used to throw so
 * existing tool errors remain byte-identical.
 */

import { hasAppManagement } from "../../adapters/platform-adapter.js";
import type { Platform } from "../../platform-types.js";
import type { AdapterResolver } from "./input-proxy.js";

export class AppProxy {
  constructor(private readonly resolve: AdapterResolver) {}

  async launchApp(packageOrBundleId: string, platform?: Platform, deviceId?: string): Promise<string> {
    const adapter = this.resolve(platform, deviceId);
    if (!hasAppManagement(adapter)) {
      throw new Error(`App management is not supported for ${adapter.platform}. ${
        adapter.platform === "browser" ? "Use browser_open instead." : ""
      }`);
    }
    return adapter.launchApp(packageOrBundleId, deviceId);
  }

  stopApp(packageOrBundleId: string, platform?: Platform, deviceId?: string): void {
    const adapter = this.resolve(platform, deviceId);
    if (!hasAppManagement(adapter)) {
      throw new Error(`App management is not supported for ${adapter.platform}. ${
        adapter.platform === "browser" ? "Use browser_close instead." : ""
      }`);
    }
    adapter.stopApp(packageOrBundleId, deviceId);
  }

  installApp(path: string, platform?: Platform, deviceId?: string): string {
    const adapter = this.resolve(platform, deviceId);
    if (!hasAppManagement(adapter)) {
      throw new Error(`App installation is not supported for ${adapter.platform}.`);
    }
    return adapter.installApp(path, deviceId);
  }
}
