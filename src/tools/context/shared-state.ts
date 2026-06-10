/**
 * Per-platform caches for UI elements, screenshots, UI tree output, and scale factors.
 *
 * Storage now lives in `SharedState` (see `./shared-state-class.ts`), owned
 * by the default RuntimeContext. This module re-exports the singleton's
 * Maps directly so existing consumers continue to receive the same
 * Map references they always have.
 */

import type { UiElement } from "../../adb/ui-parser.js";
import { getDefaultRuntimeContext } from "../../runtime/runtime-context.js";

const _state = getDefaultRuntimeContext().sharedState;

export const lastScreenshotMap: Map<string, Buffer> = _state.lastScreenshotMap;
export const lastUiTreeMap: Map<string, { text: string; timestamp: number }> = _state.lastUiTreeMap;
export const screenshotScaleMap: Map<string, { scaleX: number; scaleY: number }> =
  _state.screenshotScaleMap;

export function getCachedElements(platform: string): UiElement[] {
  return _state.getCachedElements(platform);
}

export function setCachedElements(platform: string, elements: UiElement[]): void {
  _state.setCachedElements(platform, elements);
}

export function invalidateUiTreeCache(platform?: string): void {
  _state.invalidateUiTreeCache(platform);
}
