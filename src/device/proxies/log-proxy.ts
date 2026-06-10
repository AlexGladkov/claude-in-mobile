/**
 * LogProxy — log + shell + system info ops.
 *
 * Extracted from DeviceManager (D9.1b). Guards via hasShell where the
 * facade used to. getSystemInfo is unguarded (matches previous behaviour).
 */

import { hasShell } from "../../adapters/platform-adapter.js";
import type { Platform } from "../../platform-types.js";
import type { AdapterResolver } from "./input-proxy.js";

export class LogProxy {
  constructor(private readonly resolve: AdapterResolver) {}

  shell(command: string, platform?: Platform, deviceId?: string): string {
    const adapter = this.resolve(platform, deviceId);
    if (!hasShell(adapter)) {
      throw new Error(`Shell is not supported for ${adapter.platform}.`);
    }
    return adapter.shell(command, deviceId);
  }

  getLogs(
    options: {
      platform?: Platform;
      level?: string;
      tag?: string;
      lines?: number;
      package?: string;
      deviceId?: string;
    } = {},
  ): string {
    const adapter = this.resolve(options.platform, options.deviceId);
    if (!hasShell(adapter)) {
      throw new Error(`Logs are not supported for ${adapter.platform}.`);
    }
    return adapter.getLogs({
      level: options.level,
      tag: options.tag,
      lines: options.lines,
      package: options.package,
    }, options.deviceId);
  }

  clearLogs(platform?: Platform, deviceId?: string): string {
    const adapter = this.resolve(platform, deviceId);
    if (!hasShell(adapter)) {
      throw new Error(`Logs are not supported for ${adapter.platform}.`);
    }
    return adapter.clearLogs(deviceId);
  }

  async getSystemInfo(platform?: Platform, deviceId?: string): Promise<string> {
    const adapter = this.resolve(platform, deviceId);
    return adapter.getSystemInfo(deviceId);
  }
}
