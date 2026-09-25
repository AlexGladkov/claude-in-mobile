import { defineTool, z } from "../define-tool.js";
import { platformEnum, deviceIdField } from "../common-schema.js";
import {
  parseUiHierarchy,
  harmonyHierarchyToUiElements,
  formatUiTree,
  formatUiTreeSemantic,
} from "../../ui-tree/ui-parser.js";
import type { UiElement } from "../../ui-tree/ui-parser.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult } from "../../utils/tool-result.js";
import type { ToolContext } from "../context.js";
import { screenshotStateKey } from "../context/shared-state-class.js";
import { isBuiltinPlatform } from "../../platform-types.js";
import { getUiElements } from "../helpers/get-elements.js";

/** Formatting/caching options shared by every platform that yields UiElement[]. */
interface TreeFormatOptions {
  showAll: boolean;
  compact: boolean;
  semantic: boolean;
  fresh: boolean;
}

/**
 * Single formatting + dedup-cache path shared by ALL element-based platforms
 * (Android, iOS, …). Keeping this in one place is the whole point of the fix:
 * previously iOS early-returned a bespoke tree dump and silently ignored
 * `compact` / `format:semantic` / `showAll` / `fresh`, and never enforced the
 * element limit. Routing every platform through here guarantees identical
 * behaviour for the four flags.
 */
function formatAndCacheTree(
  ctx: ToolContext,
  platform: string,
  elements: UiElement[],
  opts: TreeFormatOptions,
  deviceId?: string,
): string {
  ctx.setCachedElements(platform, elements, deviceId);

  if (opts.semantic) {
    // Semantic output is intentionally not dedup-cached (it is already the
    // cheapest format and callers ask for it to force a fresh read).
    return formatUiTreeSemantic(elements);
  }

  const tree = formatUiTree(elements, { showAll: opts.showAll, compact: opts.compact });

  const cacheKey = `${screenshotStateKey(platform, deviceId)}:${opts.showAll}:${opts.compact}`;
  const cached = opts.fresh ? undefined : ctx.lastUiTreeMap.get(cacheKey);
  const now = Date.now();
  if (cached && cached.text === tree && now - cached.timestamp < 2000) {
    const ago = now - cached.timestamp;
    return `UI unchanged (cached ${ago}ms ago). ${elements.length} elements.`;
  }
  ctx.lastUiTreeMap.set(cacheKey, { text: tree, timestamp: now });
  return tree;
}

export const uiTree = defineTool({
  name: "ui_tree",
  description: "Get UI hierarchy (accessibility tree). Shows elements, text, IDs, coordinates.",
  schema: z.object({
    showAll: z
      .boolean()
      .default(false)
      .describe("Show all elements including non-interactive ones. Applies to Android, iOS, and HarmonyOS."),
    compact: z
      .boolean()
      .optional()
      .describe("Interactive elements only — shortest format. Applies to Android, iOS, and HarmonyOS."),
    format: z
      .string()
      .optional()
      .describe("'semantic' for role-grouped output (~3x token reduction). Applies to Android, iOS, and HarmonyOS."),
    fresh: z
      .boolean()
      .optional()
      .describe("Bypass the 2-second dedup cache. Applies to Android, iOS, and HarmonyOS."),
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    const platform = args.platform;

    const opts: TreeFormatOptions = {
      showAll: args.showAll,
      compact: args.compact ?? false,
      semantic: args.format === "semantic",
      fresh: args.fresh ?? false,
    };

    if (currentPlatform === "ios") {
      try {
        const json = await ctx.deviceManager.getUiHierarchy("ios", deviceId);
        const tree = JSON.parse(json);
        // iOS already exposes UiElement[] via iosTreeToUiElements (same
        // representation Android uses), so it can share the exact formatting
        // + caching path instead of its own bespoke dump.
        const elements = ctx.iosTreeToUiElements(tree);
        return textResult(formatAndCacheTree(ctx, "ios", elements, opts, deviceId));
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(
          `iOS UI inspection requires WebDriverAgent.\n\n` +
            `Install: npm install -g appium && appium driver install xcuitest\n\n` +
            `Error: ${msg}`,
        );
      }
    }

    if (currentPlatform === "harmony") {
      const json = await ctx.deviceManager.getUiHierarchyAsync("harmony", deviceId);
      const elements = harmonyHierarchyToUiElements(json);
      return textResult(formatAndCacheTree(ctx, "harmony", elements, opts, deviceId));
    }

    if (currentPlatform === "browser" || !isBuiltinPlatform(currentPlatform)) {
      const { elements } = await getUiElements(ctx, currentPlatform, deviceId);
      return textResult(formatAndCacheTree(ctx, currentPlatform, elements, opts, deviceId));
    }

    if (currentPlatform === "desktop") {
      const { elements } = await getUiElements(ctx, currentPlatform, deviceId);
      return textResult(formatAndCacheTree(ctx, currentPlatform, elements, opts, deviceId));
    }

    const xml = await ctx.deviceManager.getUiHierarchyAsync(currentPlatform, deviceId);

    const parsedElements = parseUiHierarchy(xml);
    return textResult(formatAndCacheTree(ctx, currentPlatform, parsedElements, opts, deviceId));
  },
});
