import { defineTool, z } from "../define-tool.js";
import { platformEnum, deviceIdField } from "../common-schema.js";
import { parseUiHierarchy, formatUiTree, formatUiTreeSemantic } from "../../ui-tree/ui-parser.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult } from "../../utils/tool-result.js";
import { TRUNCATION } from "../../constants/truncation.js";

export const uiTree = defineTool({
  name: "ui_tree",
  description: "Get UI hierarchy (accessibility tree). Shows elements, text, IDs, coordinates.",
  schema: z.object({
    showAll: z.boolean().default(false).describe("Show all elements including non-interactive ones"),
    compact: z.boolean().optional().describe("Interactive elements only — shortest format."),
    format: z.string().optional().describe("'semantic' for role-grouped output (~3x token reduction)."),
    fresh: z.boolean().optional().describe("Bypass the 2-second dedup cache."),
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    const platform = args.platform;

    if (currentPlatform === "ios") {
      try {
        const json = await ctx.deviceManager.getUiHierarchy("ios", deviceId);
        const tree = JSON.parse(json);
        const formatted = ctx.formatIOSUITree(tree);
        return textResult(formatted);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(
          `iOS UI inspection requires WebDriverAgent.\n\n` +
            `Install: npm install -g appium && appium driver install xcuitest\n\n` +
            `Error: ${msg}`,
        );
      }
    }

    const xml = await ctx.deviceManager.getUiHierarchyAsync(platform, deviceId);

    if (currentPlatform === "desktop") {
      const { truncateOutput } = await import("../../utils/truncate.js");
      return textResult(truncateOutput(xml, { maxChars: TRUNCATION.DEFAULT_MAX_CHARS }));
    }

    const parsedElements = parseUiHierarchy(xml);
    ctx.setCachedElements("android", parsedElements);
    if (args.format === "semantic") {
      return textResult(formatUiTreeSemantic(parsedElements));
    }

    const showAll = args.showAll;
    const compact = args.compact ?? false;
    const tree = formatUiTree(parsedElements, { showAll, compact });

    const fresh = args.fresh ?? false;
    const cacheKey = `android:${showAll}:${compact}`;
    const cached = fresh ? undefined : ctx.lastUiTreeMap.get(cacheKey);
    const now = Date.now();
    if (cached && cached.text === tree && (now - cached.timestamp) < 2000) {
      const ago = now - cached.timestamp;
      return textResult(`UI unchanged (cached ${ago}ms ago). ${parsedElements.length} elements.`);
    }
    ctx.lastUiTreeMap.set(cacheKey, { text: tree, timestamp: now });

    return textResult(tree);
  },
});
