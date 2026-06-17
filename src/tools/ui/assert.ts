import { defineTool, z } from "../define-tool.js";
import { platformEnum, deviceIdField } from "../common-schema.js";
import { findElements, formatElement } from "../../ui-tree/ui-parser.js";
import { getUiElements } from "../helpers/get-elements.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";

export const uiAssertVisible = defineTool({
  name: "ui_assert_visible",
  description: "Assert element is visible on screen (pass/fail)",
  schema: z.object({
    text: z.string().optional().describe("Element text to check for (partial match)"),
    resourceId: z.string().optional().describe("Android: resource ID to check for"),
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    const searchText = args.text;
    const searchId = args.resourceId;

    if (!searchText && !searchId) {
      return textResult("Provide text or resourceId to assert");
    }

    const { elements } = await getUiElements(ctx, currentPlatform);

    const found = findElements(elements, {
      text: searchText,
      resourceId: searchId,
    });

    if (found.length > 0) {
      return textResult(`PASS: Element visible -- ${formatElement(found[0])}`);
    }
    return errorResult(`FAIL: Element not visible (text=${searchText ?? ""}, resourceId=${searchId ?? ""})`);
  },
});

export const uiAssertGone = defineTool({
  name: "ui_assert_gone",
  description: "Assert element does NOT exist on screen (pass/fail)",
  schema: z.object({
    text: z.string().optional().describe("Element text that should NOT be present"),
    resourceId: z.string().optional().describe("Android: resource ID that should NOT be present"),
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    const searchText = args.text;
    const searchId = args.resourceId;

    if (!searchText && !searchId) {
      return textResult("Provide text or resourceId to assert absence");
    }

    const { elements } = await getUiElements(ctx, currentPlatform);

    const found = findElements(elements, {
      text: searchText,
      resourceId: searchId,
    });

    if (found.length === 0) {
      return textResult(`PASS: Element not present (text=${searchText ?? ""}, resourceId=${searchId ?? ""})`);
    }
    return errorResult(`FAIL: Element exists -- ${formatElement(found[0])}`);
  },
});
