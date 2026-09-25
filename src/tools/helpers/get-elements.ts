/**
 * Platform-dispatched UI element fetching.
 *
 * Consolidates the repeated if/else chains that appear in ui_tree,
 * ui_find, ui_analyze, ui_wait, ui_assert_visible, ui_assert_gone, etc.
 */

import type { ToolContext } from "../context.js";
import type { DeviceManager, Platform } from "../../device-manager.js";
import { isBuiltinPlatform } from "../../platform-types.js";
import {
  hasUi,
} from "../../adapters/platform-adapter.js";
import type { PluginUiElement } from "@mcp-devices/plugin-api";
import {
  parseUiHierarchy,
  harmonyHierarchyToUiElements,
  UiElement,
} from "../../ui-tree/ui-parser.js";
import { isSecureElement, REDACTED } from "../../ui-tree/ui-parser/formatters/redact.js";

export interface GetUiElementsResult {
  elements: UiElement[];
  /** Raw hierarchy string for hierarchy-backed platforms that still need it. */
  rawTree?: string;
}

export const MAX_PLUGIN_UI_NODES = 10_000;
export const MAX_PLUGIN_UI_DEPTH = 256;
export const MAX_PLUGIN_UI_STRING_CHARS = 8_192;
export const MAX_PLUGIN_UI_TOTAL_STRING_CHARS = 1_048_576;

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}


/**
 * Convert the public platform-neutral UI record into the host's normalized
 * element format. Provider records are untrusted, so traversal is iterative
 * and bounded; repeated object references are rejected rather than allowing a
 * cycle or shared graph to consume unbounded memory.
 */
export function normalizePluginUiElements(
  records: readonly PluginUiElement[],
): UiElement[] {
  if (!Array.isArray(records)) {
    throw new Error("UI element provider returned an invalid record list.");
  }
  if (records.length > MAX_PLUGIN_UI_NODES) {
    throw new Error(
      `UI element provider exceeded the ${MAX_PLUGIN_UI_NODES}-node limit.`,
    );
  }

  const elements: UiElement[] = [];
  const seen = new WeakSet<object>();
  const pending: Array<{ record: PluginUiElement; depth: number }> = [];
  for (let index = records.length - 1; index >= 0; index--) {
    pending.push({ record: records[index], depth: 0 });
  }

  let visited = 0;
  let totalStringChars = 0;
  const readString = (value: unknown, field: string): string => {
    if (value === undefined) return "";
    if (typeof value !== "string") {
      throw new Error(`UI element provider returned a non-string ${field}.`);
    }
    if (value.length > MAX_PLUGIN_UI_STRING_CHARS) {
      throw new Error(
        `UI element provider exceeded the ${MAX_PLUGIN_UI_STRING_CHARS}-character ${field} limit.`,
      );
    }
    totalStringChars += value.length;
    if (totalStringChars > MAX_PLUGIN_UI_TOTAL_STRING_CHARS) {
      throw new Error(
        `UI element provider exceeded the ${MAX_PLUGIN_UI_TOTAL_STRING_CHARS}-character text limit.`,
      );
    }
    return value;
  };

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const { record, depth } = current;
    if (depth > MAX_PLUGIN_UI_DEPTH) {
      throw new Error(
        `UI element provider exceeded the ${MAX_PLUGIN_UI_DEPTH}-level depth limit.`,
      );
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error("UI element provider returned an invalid record.");
    }
    if (record.visible === false) continue;
    if (seen.has(record)) {
      throw new Error("UI element provider returned a cyclic or repeated record graph.");
    }
    seen.add(record);
    if (++visited > MAX_PLUGIN_UI_NODES) {
      throw new Error(
        `UI element provider exceeded the ${MAX_PLUGIN_UI_NODES}-node limit.`,
      );
    }

    const bounds = record.bounds;
    const x = finiteOr(bounds?.x, 0);
    const y = finiteOr(bounds?.y, 0);
    const width = Math.max(0, finiteOr(bounds?.width, 0));
    const height = Math.max(0, finiteOr(bounds?.height, 0));
    const text = readString(record.text ?? record.label ?? record.value, "text");
    const className = readString(record.className ?? record.role, "className");
    const resourceId = readString(record.resourceId ?? record.id, "resourceId");
    const packageName = readString(record.packageName, "packageName");
    const contentDesc = readString(record.contentDesc ?? record.label, "contentDesc");
    const centerX = finiteOr(record.centerX, x + width / 2);
    const centerY = finiteOr(record.centerY, y + height / 2);
    const index = record.index;
    const hasProviderValue = record.value !== undefined;

    const element: UiElement = {
      index: typeof index === "number" && Number.isSafeInteger(index) && index >= 0
        ? index
        : elements.length,
      resourceId,
      className,
      packageName,
      text,
      contentDesc,
      checkable: record.checkable ?? false,
      checked: record.checked ?? false,
      clickable: record.clickable ?? false,
      enabled: record.enabled ?? true,
      focusable: record.focusable ?? false,
      focused: record.focused ?? false,
      scrollable: record.scrollable ?? false,
      longClickable: record.longClickable ?? false,
      password: Boolean(record.password) || hasProviderValue,
      selected: record.selected ?? false,
      bounds: {
        x1: x,
        y1: y,
        x2: x + width,
        y2: y + height,
      },
      centerX,
      centerY,
      width,
      height,
    };
    const secure = isSecureElement({ ...element, role: record.role } as UiElement);
    if (secure) {
      element.resourceId = REDACTED;
      element.text = REDACTED;
      element.contentDesc = REDACTED;
    }
    elements.push(element);

    const children = record.children;
    if (children === undefined) continue;
    if (!Array.isArray(children)) {
      throw new Error("UI element provider returned invalid children.");
    }
    if (children.length > MAX_PLUGIN_UI_NODES - visited - pending.length) {
      throw new Error(
        `UI element provider exceeded the ${MAX_PLUGIN_UI_NODES}-node limit.`,
      );
    }
    if (children.length > 0 && depth === MAX_PLUGIN_UI_DEPTH) {
      throw new Error(
        `UI element provider exceeded the ${MAX_PLUGIN_UI_DEPTH}-level depth limit.`,
      );
    }
    for (let childIndex = children.length - 1; childIndex >= 0; childIndex--) {
      pending.push({ record: children[childIndex], depth: depth + 1 });
    }
  }
  return elements;
}
export async function getExternalUiElements(
  deviceManager: DeviceManager,
  platform: string,
  deviceId?: string,
): Promise<UiElement[]> {
  const adapter = deviceManager.getAdapter(platform as Platform, deviceId);
  if (!hasUi(adapter) || typeof adapter.getUiElements !== "function") {
    throw new Error(`UI element provider is not supported for ${platform}.`);
  }
  const records = await adapter.getUiElements(deviceId);
  if (!Array.isArray(records)) {
    throw new Error(`UI element provider returned an invalid record list for ${platform}.`);
  }
  return normalizePluginUiElements(records);
}

/**
 * Fetch and parse UI elements for the given platform.
 *
 * Side-effect: updates the cached elements via ctx.setCachedElements().
 */
export async function getUiElements(
  ctx: ToolContext,
  platform: Platform | string | undefined,
  deviceId?: string,
): Promise<GetUiElementsResult> {
  const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

  if (currentPlatform === "ios") {
    const json = await ctx.deviceManager.getUiHierarchy("ios", deviceId);
    const tree = JSON.parse(json);
    const elements = ctx.iosTreeToUiElements(tree);
    ctx.setCachedElements("ios", elements, deviceId);
    return { elements };
  }

  if (currentPlatform === "harmony") {
    const hierarchyText = await ctx.deviceManager.getUiHierarchyAsync("harmony", deviceId);
    const elements = harmonyHierarchyToUiElements(hierarchyText);
    ctx.setCachedElements("harmony", elements, deviceId);
    return { elements, rawTree: hierarchyText };
  }

  if (currentPlatform === "desktop") {
    const elements = await getExternalUiElements(ctx.deviceManager, currentPlatform, deviceId);
    ctx.setCachedElements(currentPlatform, elements, deviceId);
    return { elements };
  }

  if (currentPlatform === "browser" || !isBuiltinPlatform(currentPlatform)) {
    const elements = await getExternalUiElements(ctx.deviceManager, currentPlatform, deviceId);
    ctx.setCachedElements(currentPlatform, elements, deviceId);
    return { elements };
  }

  // XML-based fallback (Android and legacy Aurora hierarchy output).
  const fallbackPlatform = currentPlatform as Platform;
  const xml = await ctx.deviceManager.getUiHierarchyAsync(fallbackPlatform, deviceId);
  const elements = parseUiHierarchy(xml);
  ctx.setCachedElements(currentPlatform, elements, deviceId);
  return { elements, rawTree: xml };
}
