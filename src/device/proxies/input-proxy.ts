/**
 * InputProxy — input ops (tap/swipe/key/text).
 *
 * Extracted from DeviceManager (D9.1b) to slim the facade. Behaviour is
 * preserved: each method resolves the adapter via the injected resolver
 * and delegates to it. No state lives on the proxy.
 */

import type { CorePlatformAdapter, DragOptions } from "../../adapters/platform-adapter.js";
import { hasDrag, CapabilityNotSupportedError } from "../../adapters/platform-adapter.js";
import type { Platform } from "../../platform-types.js";

export type AdapterResolver = (platform?: Platform, deviceId?: string) => CorePlatformAdapter;

export class InputProxy {
  constructor(private readonly resolve: AdapterResolver) {}

  async tap(x: number, y: number, platform?: Platform, targetPid?: number, deviceId?: string): Promise<void> {
    const adapter = this.resolve(platform, deviceId);
    await adapter.tap(x, y, targetPid, deviceId);
  }

  async doubleTap(
    x: number,
    y: number,
    intervalMs: number = 100,
    platform?: Platform,
    deviceId?: string,
  ): Promise<void> {
    const adapter = this.resolve(platform, deviceId);
    await adapter.doubleTap(x, y, intervalMs, deviceId);
  }

  async longPress(
    x: number,
    y: number,
    durationMs: number = 1000,
    platform?: Platform,
    deviceId?: string,
  ): Promise<void> {
    const adapter = this.resolve(platform, deviceId);
    await adapter.longPress(x, y, durationMs, deviceId);
  }

  async swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs: number = 300,
    platform?: Platform,
    deviceId?: string,
  ): Promise<void> {
    const adapter = this.resolve(platform, deviceId);
    await adapter.swipe(x1, y1, x2, y2, durationMs, deviceId);
  }

  async swipeDirection(
    direction: "up" | "down" | "left" | "right",
    platform?: Platform,
    deviceId?: string,
  ): Promise<void> {
    const adapter = this.resolve(platform, deviceId);
    await adapter.swipeDirection(direction, deviceId);
  }

  /** True when the resolved adapter supports a first-class held drag. */
  supportsDrag(platform?: Platform, deviceId?: string): boolean {
    return hasDrag(this.resolve(platform, deviceId));
  }

  async drag(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    opts?: DragOptions,
    platform?: Platform,
    deviceId?: string,
  ): Promise<void> {
    const adapter = this.resolve(platform, deviceId);
    if (!hasDrag(adapter)) {
      throw new CapabilityNotSupportedError(adapter.platform, "Drag");
    }
    await adapter.drag(x1, y1, x2, y2, opts, deviceId);
  }

  async inputText(text: string, platform?: Platform, targetPid?: number, deviceId?: string): Promise<void> {
    const adapter = this.resolve(platform, deviceId);
    await adapter.inputText(text, targetPid, deviceId);
  }

  async pressKey(key: string, platform?: Platform, targetPid?: number, deviceId?: string): Promise<void> {
    const adapter = this.resolve(platform, deviceId);
    await adapter.pressKey(key, targetPid, deviceId);
  }
}
