import type { UiElement } from "../../adb/ui-parser.js";

/**
 * SharedState — encapsulates the per-platform caches that used to live as
 * module-level `Map`s in `shared-state.ts`. The legacy module re-exports
 * the singleton instance's Maps directly so existing consumers
 * (`ctx.lastScreenshotMap`, etc.) keep working.
 */
export class SharedState {
  readonly cachedElementsMap = new Map<string, UiElement[]>();
  readonly lastScreenshotMap = new Map<string, Buffer>();
  readonly lastUiTreeMap = new Map<string, { text: string; timestamp: number }>();
  readonly screenshotScaleMap = new Map<string, { scaleX: number; scaleY: number }>();

  getCachedElements(platform: string): UiElement[] {
    return this.cachedElementsMap.get(platform) ?? [];
  }

  setCachedElements(platform: string, elements: UiElement[]): void {
    this.cachedElementsMap.set(platform, elements);
  }

  invalidateUiTreeCache(platform?: string): void {
    if (platform) {
      for (const key of this.lastUiTreeMap.keys()) {
        if (key.startsWith(platform)) this.lastUiTreeMap.delete(key);
      }
    } else {
      this.lastUiTreeMap.clear();
    }
  }
}
