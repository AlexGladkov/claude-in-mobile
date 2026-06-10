/**
 * PermissionProxy — grant/revoke/reset permission ops.
 *
 * Extracted from DeviceManager (D9.1b). Guards via hasPermissions; error
 * messages preserved verbatim.
 */

import { hasPermissions } from "../../adapters/platform-adapter.js";
import type { Platform } from "../../platform-types.js";
import type { AdapterResolver } from "./input-proxy.js";

export class PermissionProxy {
  constructor(private readonly resolve: AdapterResolver) {}

  grantPermission(
    packageOrBundleId: string,
    permission: string,
    platform?: Platform,
    deviceId?: string,
  ): string {
    const adapter = this.resolve(platform, deviceId);
    if (!hasPermissions(adapter)) {
      throw new Error(
        `Permission management is not supported for ${adapter.platform}. ` +
        `Supported platforms: android, ios.`,
      );
    }
    return adapter.grantPermission(packageOrBundleId, permission, deviceId);
  }

  revokePermission(
    packageOrBundleId: string,
    permission: string,
    platform?: Platform,
    deviceId?: string,
  ): string {
    const adapter = this.resolve(platform, deviceId);
    if (!hasPermissions(adapter)) {
      throw new Error(
        `Permission management is not supported for ${adapter.platform}. ` +
        `Supported platforms: android, ios.`,
      );
    }
    return adapter.revokePermission(packageOrBundleId, permission, deviceId);
  }

  resetPermissions(packageOrBundleId: string, platform?: Platform, deviceId?: string): string {
    const adapter = this.resolve(platform, deviceId);
    if (!hasPermissions(adapter)) {
      throw new Error(
        `Permission management is not supported for ${adapter.platform}. ` +
        `Supported platforms: android, ios.`,
      );
    }
    return adapter.resetPermissions(packageOrBundleId, deviceId);
  }
}
