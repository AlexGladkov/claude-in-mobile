/**
 * Action hints generation: diff before/after UI state to suggest next actions.
 * Also provides a helper to fetch UI elements for the current platform.
 */

import { DeviceManager } from "../../device-manager.js";
import {
  parseUiHierarchy,
  desktopHierarchyToUiElements,
  diffUiElements,
  suggestNextActions,
  UiElement,
} from "../../adb/ui-parser.js";
import { iosTreeToUiElements } from "./ios-helpers.js";
import { getCachedElements, setCachedElements } from "./shared-state.js";

/**
 * Generate action hints by diffing before/after UI state.
 *
 * NOTE: This is a factory — it captures the deviceManager reference so callers
 * do not need to pass it on every invocation.
 */
export function createGenerateActionHints(deviceManager: DeviceManager) {
  return async function generateActionHints(platform: string | undefined): Promise<string> {
    const currentPlatform = platform ?? deviceManager.getCurrentPlatform() ?? "android";
    const beforeElements = getCachedElements(currentPlatform);

    await new Promise(resolve => setTimeout(resolve, 150));

    let afterElements: UiElement[] = [];
    try {
      if (currentPlatform === "android") {
        const xml = await deviceManager.getUiHierarchyAsync("android");
        afterElements = parseUiHierarchy(xml);
      } else if (currentPlatform === "ios") {
        const json = await deviceManager.getUiHierarchy("ios");
        const tree = JSON.parse(json);
        afterElements = iosTreeToUiElements(tree);
      } else if (currentPlatform === "desktop") {
        const text = await deviceManager.getUiHierarchyAsync("desktop");
        afterElements = desktopHierarchyToUiElements(text);
      }
    } catch (hintError: any) {
      const reason = hintError?.message ?? "unknown error";
      return `\n--- Hints ---\nUnable to fetch UI state for hints: ${reason}`;
    }

    setCachedElements(currentPlatform, afterElements);

    if (beforeElements.length === 0 && afterElements.length === 0) {
      return "\n--- Hints ---\nNo UI elements detected.";
    }

    const diff = diffUiElements(beforeElements, afterElements);
    const suggestions = suggestNextActions(afterElements);

    const lines: string[] = ["\n--- Hints ---"];

    if (diff.screenChanged) {
      lines.push("Screen changed (new activity or major UI update)");
    }
    if (diff.appeared.length > 0) {
      lines.push(`New: ${diff.appeared.join(", ")}`);
    }
    if (diff.disappeared.length > 0) {
      lines.push(`Gone: ${diff.disappeared.join(", ")}`);
    }
    lines.push(`Elements: ${diff.beforeCount} -> ${diff.afterCount}`);
    if (suggestions.length > 0) {
      lines.push(`Suggested: ${suggestions.join("; ")}`);
    }

    return lines.join("\n");
  };
}

/**
 * Get UI elements for the current platform (helper for flow element checks).
 *
 * Factory that captures the deviceManager reference.
 */
export function createGetElementsForPlatform(deviceManager: DeviceManager) {
  return async function getElementsForPlatform(plat: string): Promise<UiElement[]> {
    if (plat === "android" || !plat) {
      const xml = await deviceManager.getUiHierarchyAsync("android");
      const elements = parseUiHierarchy(xml);
      setCachedElements("android", elements);
      return elements;
    } else if (plat === "ios") {
      const json = await deviceManager.getUiHierarchy("ios");
      const tree = JSON.parse(json);
      const elements = iosTreeToUiElements(tree);
      setCachedElements("ios", elements);
      return elements;
    } else if (plat === "desktop") {
      const text = await deviceManager.getUiHierarchyAsync("desktop");
      const elements = desktopHierarchyToUiElements(text);
      setCachedElements("desktop", elements);
      return elements;
    }
    return [];
  };
}
