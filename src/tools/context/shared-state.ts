/**
 * Per-platform/device caches for UI elements, screenshots, UI tree output, and scale factors.
 *
 * Storage now lives in `SharedState` (see `./shared-state-class.ts`), owned
 * by the default RuntimeContext. This module re-exports the singleton's
 * Maps directly so existing consumers continue to receive the same
 * Map references they always have.
 */

import type { UiElement } from "../../ui-tree/ui-parser.js";
import type { ScreenshotScale } from "./shared-state-class.js";
import { getDefaultRuntimeContext } from "../../runtime/runtime-context.js";

const _state = getDefaultRuntimeContext().sharedState;

export const lastScreenshotMap: Map<string, Buffer> = _state.lastScreenshotMap;
export const lastUiTreeMap: Map<string, { text: string; timestamp: number }> = _state.lastUiTreeMap;
export const screenshotScaleMap: Map<string, ScreenshotScale> = _state.screenshotScaleMap;

export function getCachedElements(platform: string, deviceId?: string): UiElement[] {
  return _state.getCachedElements(platform, deviceId);
}

export function isCachedElementsStale(platform: string, deviceId?: string): boolean {
  return _state.isCachedElementsStale(platform, deviceId);
}

export function setCachedElements(platform: string, elements: UiElement[], deviceId?: string): void {
  _state.setCachedElements(platform, elements, deviceId);
}
export function invalidateUiTreeCache(platform?: string, deviceId?: string): void {
  _state.invalidateUiTreeCache(platform, deviceId);
}
