/**
 * Consolidated element coordinate resolution for interaction tools.
 *
 * Handles the common pattern shared by input_tap, input_double_tap,
 * and input_long_press: resolving an element by label, index, text,
 * or resourceId into (x, y) coordinates ready for device input.
 */

import type { ToolContext } from "../context.js";
import type { Platform } from "../../device-manager.js";
import { findByText, findByResourceId } from "../../ui-tree/ui-parser.js";
import type { UiElement } from "../../ui-tree/ui-parser.js";
import { ElementNotFoundError } from "../../errors.js";
import { getUiElements } from "./get-elements.js";
import { screenshotStateKey } from "../context/shared-state-class.js";

export interface ResolvedCoordinates {
  x: number;
  y: number;
  /** What was matched, for logging (e.g. "label 'Submit'", "index 3") */
  description: string;
  /** True when coordinates came from raw x/y args (need scale correction) */
  fromRawArgs: boolean;
  /** If iOS element-based tap was performed directly (no coordinates needed) */
  iosTapDone?: boolean;
  /** WDA element ID — available when rect lookup failed but element was found */
  elementId?: string;
}

/**
 * Apply screenshot scale to raw coordinates from Claude (image space -> device space).
 */
export async function applyScale(
  x: number,
  y: number,
  platform: string | undefined,
  ctx: ToolContext,
  deviceId?: string,
): Promise<{ x: number; y: number }> {
  const platformKey = platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";
  const scale = ctx.screenshotScaleMap.get(screenshotStateKey(platformKey, deviceId));
  if (!scale) return { x, y };

  let { scaleX, scaleY } = scale;
  if (platformKey === "ios") {
    // Screenshots are measured in device pixels; WDA's coordinate APIs take
    // points. Apply this even for an uncompressed 1× screenshot.
    const points = await ctx.deviceManager
      .getIosClient(deviceId)
      .getScreenPointSize(deviceId);
    if (points.width <= 0 || points.height <= 0) {
      throw new Error("WebDriverAgent returned an invalid iOS screen size");
    }
    scaleX *= points.width / scale.originalWidth;
    scaleY *= points.height / scale.originalHeight;
  }

  if (scaleX === 1 && scaleY === 1) return { x, y };
  return { x: Math.round(x * scaleX), y: Math.round(y * scaleY) };
}

/**
 * Resolve element coordinates from tool arguments.
 *
 * Resolution priority:
 * 1. iOS label/text -> WDA element tap (returns iosTapDone)
 * 2. Android/HarmonyOS index -> cached/fresh element lookup
 * 3. Android/HarmonyOS text/resourceId -> fresh element lookup
 * 4. Raw x/y coordinates (need scale correction)
 *
 * Returns null if no coordinates could be resolved (caller should throw).
 */
export async function resolveElementCoordinates(
  args: Record<string, unknown>,
  ctx: ToolContext,
  currentPlatform: Platform | string | undefined,
  deviceId?: string,
): Promise<ResolvedCoordinates | null> {
  // 1. iOS element-based resolution (precedence: label > text > coordinates)
  if (currentPlatform === "ios" && (args.label || args.text)) {
    try {
      const iosClient = ctx.deviceManager.getIosClient(deviceId);
      const element = await iosClient.findElement({
        text: args.text as string,
        label: args.label as string,
      });
      // Get element rect for center coordinates (works for tap, long_press, etc.)
      const rect = await iosClient.getElementRect(element.ELEMENT);
      if (rect) {
        return {
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
          description: String(args.label || args.text),
          fromRawArgs: false,
        };
      }
      // Rect unavailable — return element ID so callers can act on element directly
      return {
        x: 0,
        y: 0,
        description: String(args.label || args.text),
        fromRawArgs: false,
        iosTapDone: true,
        elementId: element.ELEMENT,
      };
    } catch {
      throw new ElementNotFoundError(String(args.label || args.text));
    }
  }

  const hierarchyPlatform =
    currentPlatform === "android" || currentPlatform === "harmony"
      ? currentPlatform
      : undefined;

  // 2. Find by index from cached elements -- device coords, no scale
  if (args.index !== undefined && hierarchyPlatform) {
    const idx = args.index as number;
    let elements = ctx.getCachedElements(hierarchyPlatform);
    if (elements.length === 0) {
      ({ elements } = await getUiElements(ctx, hierarchyPlatform, deviceId));
    }
    const el = elements.find((element) => element.index === idx);
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

  // 3. Find by text or resourceId -- device coords, no scale
  if ((args.text || args.resourceId) && hierarchyPlatform) {
    const { elements } = await getUiElements(
      ctx,
      hierarchyPlatform,
      deviceId,
    );

    let found: UiElement[] = [];
    if (args.text) {
      found = findByText(elements, args.text as string);
    } else if (args.resourceId) {
      found = findByResourceId(elements, args.resourceId as string);
    }

    if (found.length === 0) {
      throw new ElementNotFoundError(String(args.text || args.resourceId));
    }

    const clickable = found.filter((element) => element.clickable);
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
