/**
 * Platform-dispatched UI element fetching.
 *
 * Consolidates the repeated if/else chains that appear in ui_tree,
 * ui_find, ui_analyze, ui_wait, ui_assert_visible, ui_assert_gone, etc.
 */

import type { ToolContext } from "../context.js";
import type { Platform } from "../../device-manager.js";
import {
  parseUiHierarchy,
  desktopHierarchyToUiElements,
  UiElement,
} from "../../adb/ui-parser.js";

export interface GetUiElementsResult {
  elements: UiElement[];
  /** Raw hierarchy string (only for desktop/ios when needed) */
  rawTree?: string;
}

/**
 * Fetch and parse UI elements for the given platform.
 *
 * Side-effect: updates the cached elements via ctx.setCachedElements().
 */
export async function getUiElements(
  ctx: ToolContext,
  platform: Platform | string | undefined,
): Promise<GetUiElementsResult> {
  const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

  if (currentPlatform === "ios") {
    const json = await ctx.deviceManager.getUiHierarchy("ios");
    const tree = JSON.parse(json);
    const elements = ctx.iosTreeToUiElements(tree);
    ctx.setCachedElements("ios", elements);
    return { elements };
  }

  if (currentPlatform === "desktop") {
    const hierarchyText = await ctx.deviceManager.getUiHierarchyAsync("desktop");
    const elements = desktopHierarchyToUiElements(hierarchyText);
    ctx.setCachedElements("desktop", elements);
    return { elements, rawTree: hierarchyText };
  }

  // Default: android
  const xml = await ctx.deviceManager.getUiHierarchyAsync(platform as Platform | undefined);
  const elements = parseUiHierarchy(xml);
  ctx.setCachedElements("android", elements);
  return { elements, rawTree: xml };
}
