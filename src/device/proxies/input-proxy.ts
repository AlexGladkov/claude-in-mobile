/**
 * InputProxy — input ops (tap/swipe/key/text).
 *
 * Extracted from DeviceManager (D9.1b) to slim the facade. Behaviour is
 * preserved: each method resolves the adapter via the injected resolver
 * and delegates to it. No state lives on the proxy.
 */

import { hasInput } from "../../adapters/platform-adapter.js";
import type { CorePlatformAdapter } from "../../adapters/platform-adapter.js";
import type { PluginInputAdapter } from "@mcp-devices/plugin-api";
import type { Platform } from "../../platform-types.js";

export type AdapterResolver = (platform?: Platform, deviceId?: string) => CorePlatformAdapter;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Tool operation was cancelled.");
  }
}

function requireInput(
  resolve: AdapterResolver,
  platform: Platform | undefined,
  deviceId: string | undefined,
): CorePlatformAdapter & PluginInputAdapter {
  const adapter = resolve(platform, deviceId);
  if (!(hasInput(adapter) as boolean)) {
    throw new Error(`Input is not supported for ${adapter.platform}.`);
  }
  return adapter;
}
export class InputProxy {
  constructor(private readonly resolve: AdapterResolver) {}

  async tap(
    x: number,
    y: number,
    platform?: Platform,
    targetPid?: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const adapter = requireInput(this.resolve, platform, deviceId);
    throwIfAborted(signal);
    await adapter.tap(x, y, targetPid, deviceId, signal);
  }

  async doubleTap(
    x: number,
    y: number,
    intervalMs: number = 100,
    platform?: Platform,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const adapter = requireInput(this.resolve, platform, deviceId);
    throwIfAborted(signal);
    await adapter.doubleTap(x, y, intervalMs, deviceId, signal);
  }

  async longPress(
    x: number,
    y: number,
    durationMs: number = 1000,
    platform?: Platform,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const adapter = requireInput(this.resolve, platform, deviceId);
    throwIfAborted(signal);
    await adapter.longPress(x, y, durationMs, deviceId, signal);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number = 300,
    platform?: Platform,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const adapter = requireInput(this.resolve, platform, deviceId);
    throwIfAborted(signal);
    await adapter.swipe(x1, y1, x2, y2, durationMs, deviceId, signal);
  }

  async swipeDirection(
    direction: "up" | "down" | "left" | "right",
    platform?: Platform,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const adapter = requireInput(this.resolve, platform, deviceId);
    throwIfAborted(signal);
    await adapter.swipeDirection(direction, deviceId, signal);
  }

  async inputText(
    text: string,
    platform?: Platform,
    targetPid?: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const adapter = requireInput(this.resolve, platform, deviceId);
    throwIfAborted(signal);
    await adapter.inputText(text, targetPid, deviceId, signal);
  }

  async pressKey(
    key: string,
    platform?: Platform,
    targetPid?: number,
    deviceId?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const adapter = requireInput(this.resolve, platform, deviceId);
    throwIfAborted(signal);
    await adapter.pressKey(key, targetPid, deviceId, signal);
  }
}
