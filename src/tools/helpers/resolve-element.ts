/**
 * Consolidated element coordinate resolution for interaction tools.
 *
 * Handles the common pattern shared by input_tap, input_double_tap,
 * and input_long_press: resolving an element by label, index, text,
 * or resourceId into (x, y) coordinates ready for device input.
 */

import type { ToolContext } from "../context.js";
import type { Platform } from "../../device-manager.js";
import { parseUiHierarchy, findByText, findByResourceId } from "../../adb/ui-parser.js";
import { ElementNotFoundError } from "../../errors.js";

export interface ResolvedCoordinates {
  x: number;
  y: number;
  /** What was matched, for logging (e.g. "label 'Submit'", "index 3") */
  description: string;
  /** True when coordinates came from raw x/y args (need scale correction) */
  fromRawArgs: boolean;
  /** If iOS element-based tap was performed directly (no coordinates needed) */
  iosTapDone?: boolean;
}

/**
 * Apply screenshot scale to raw coordinates from Claude (image space -> device space).
 */
export function applyScale(
  x: number,
  y: number,
  platform: string | undefined,
  ctx: ToolContext,
): { x: number; y: number } {
  const key = platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";
  const scale = ctx.screenshotScaleMap.get(key);
  if (!scale || (scale.scaleX === 1 && scale.scaleY === 1)) return { x, y };
  return {
    x: Math.round(x * scale.scaleX),
    y: Math.round(y * scale.scaleY),
  };
}

/**
 * Resolve element coordinates from tool arguments.
 *
 * Resolution priority:
 * 1. iOS label/text -> WDA element tap (returns iosTapDone)
 * 2. Android index -> cached/fresh element lookup
 * 3. Android text/resourceId -> fresh element lookup
 * 4. Raw x/y coordinates (need scale correction)
 *
 * Returns null if no coordinates could be resolved (caller should throw).
 */
export async function resolveElementCoordinates(
  args: Record<string, unknown>,
  ctx: ToolContext,
  currentPlatform: Platform | string | undefined,
): Promise<ResolvedCoordinates | null> {
  // 1. iOS element-based tap (precedence: label > text > coordinates)
  if (currentPlatform === "ios" && (args.label || args.text)) {
    try {
      const iosClient = ctx.deviceManager.getIosClient();
      const element = await iosClient.findElement({
        text: args.text as string,
        label: args.label as string,
      });
      await iosClient.tapElement(element.ELEMENT);
      return {
        x: 0,
        y: 0,
        description: String(args.label || args.text),
        fromRawArgs: false,
        iosTapDone: true,
      };
    } catch (_error: any) {
      throw new ElementNotFoundError(String(args.label || args.text));
    }
  }

  // 2. Find by index from cached elements (Android only) -- device coords, no scale
  if (args.index !== undefined && currentPlatform === "android") {
    const idx = args.index as number;
    let elements = ctx.getCachedElements("android");
    if (elements.length === 0) {
      const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
      elements = parseUiHierarchy(xml);
      ctx.setCachedElements("android", elements);
    }
    const el = elements.find(e => e.index === idx);
    if (!el) {
      throw new ElementNotFoundError(`index ${idx}`);
    }
    return {
      x: el.centerX,
      y: el.centerY,
      description: `index ${idx}`,
      fromRawArgs: false,
    };
  }

  // 3. Find by text or resourceId (Android only) -- device coords, no scale
  if ((args.text || args.resourceId) && currentPlatform === "android") {
    const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
    const elements = parseUiHierarchy(xml);
    ctx.setCachedElements("android", elements);

    let found: import("../../adb/ui-parser.js").UiElement[] = [];
    if (args.text) {
      found = findByText(elements, args.text as string);
    } else if (args.resourceId) {
      found = findByResourceId(elements, args.resourceId as string);
    }

    if (found.length === 0) {
      throw new ElementNotFoundError(String(args.text || args.resourceId));
    }

    const clickable = found.filter(el => el.clickable);
    const target = clickable[0] ?? found[0];
    return {
      x: target.centerX,
      y: target.centerY,
      description: String(args.text || args.resourceId),
      fromRawArgs: false,
    };
  }

  // 4. Raw x/y coordinates (need scale correction)
  const x = args.x as number | undefined;
  const y = args.y as number | undefined;
  if (x !== undefined && y !== undefined) {
    return {
      x,
      y,
      description: `(${x}, ${y})`,
      fromRawArgs: true,
    };
  }

  return null;
}
