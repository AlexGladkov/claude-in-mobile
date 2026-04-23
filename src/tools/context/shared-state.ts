/**
 * Per-platform caches for UI elements, screenshots, UI tree output, and scale factors.
 *
 * These maps are shared singletons used across tool handlers to avoid
 * redundant device queries within the same interaction.
 */

import type { UiElement } from "../../adb/ui-parser.js";

// Per-platform cache for UI elements (to support tap by index)
const cachedElementsMap: Map<string, UiElement[]> = new Map();

// Per-platform cache for last screenshot buffer (for diff mode)
export const lastScreenshotMap: Map<string, Buffer> = new Map();

// Per-platform cache for last ui_tree output (for dedup)
export const lastUiTreeMap: Map<string, { text: string; timestamp: number }> = new Map();

// Per-platform screenshot scale factors (compressed image -> device coordinates)
export const screenshotScaleMap: Map<string, { scaleX: number; scaleY: number }> = new Map();

export function getCachedElements(platform: string): UiElement[] {
  return cachedElementsMap.get(platform) ?? [];
}

export function setCachedElements(platform: string, elements: UiElement[]): void {
  cachedElementsMap.set(platform, elements);
}
