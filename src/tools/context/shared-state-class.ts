import type { UiElement } from "../../ui-tree/ui-parser.js";
export interface ScreenshotScale {
  scaleX: number;
  scaleY: number;
  originalWidth: number;
  originalHeight: number;
}

export function screenshotStateKey(platform: string, deviceId?: string): string {
  return deviceId === undefined ? platform : `${platform}:${encodeURIComponent(deviceId)}`;
}


/**
 * SharedState — encapsulates the per-platform/device caches that used to live
 * as module-level `Map`s in `shared-state.ts`. The legacy module re-exports
 * the singleton instance's Maps directly so existing consumers
 * (`ctx.lastScreenshotMap`, etc.) keep working.
 */
export class SharedState {
  readonly cachedElementsMap = new Map<string, UiElement[]>();
  readonly staleElementKeys = new Set<string>();
  readonly lastScreenshotMap = new Map<string, Buffer>();
  readonly lastUiTreeMap = new Map<string, { text: string; timestamp: number }>();
  readonly screenshotScaleMap = new Map<string, ScreenshotScale>();

  getCachedElements(platform: string, deviceId?: string): UiElement[] {
    return this.cachedElementsMap.get(screenshotStateKey(platform, deviceId)) ?? [];
  }

  isCachedElementsStale(platform: string, deviceId?: string): boolean {
    return this.staleElementKeys.has(screenshotStateKey(platform, deviceId));
  }

  /**
   * Store the result for a successful UI read. Callers that receive a
   * degraded/error response must not call this method, while a valid empty
   * accessibility tree intentionally clears stale coordinates.
   */
  setCachedElements(platform: string, elements: UiElement[], deviceId?: string): void {
    const key = screenshotStateKey(platform, deviceId);
    this.cachedElementsMap.set(key, elements);
    this.staleElementKeys.delete(key);
  }

  invalidateUiTreeCache(platform?: string, deviceId?: string): void {
    if (platform) {
      const stateKey = screenshotStateKey(platform, deviceId);
      const prefix = `${stateKey}:`;
      for (const key of this.cachedElementsMap.keys()) {
        if (key === stateKey || key.startsWith(prefix)) this.staleElementKeys.add(key);
      }
      for (const key of this.lastUiTreeMap.keys()) {
        if (key === stateKey || key.startsWith(prefix)) this.lastUiTreeMap.delete(key);
      }
      return;
    }

    if (deviceId !== undefined) {
      const deviceMarker = `:${encodeURIComponent(deviceId)}`;
      for (const key of this.cachedElementsMap.keys()) {
        if (key.endsWith(deviceMarker)) this.staleElementKeys.add(key);
      }
      const treeMarker = `${deviceMarker}:`;
      for (const key of this.lastUiTreeMap.keys()) {
        if (key.includes(treeMarker)) this.lastUiTreeMap.delete(key);
      }
      return;
    }

    for (const key of this.cachedElementsMap.keys()) this.staleElementKeys.add(key);
    this.lastUiTreeMap.clear();
  }
}
