import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { defineTool, z } from "./define-tool.js";
import { parseUiHierarchy, findByText, findByResourceId } from "../ui-tree/ui-parser.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";
import { sleep } from "../utils/sleep.js";
import { CLIPBOARD } from "../constants/timeouts.js";

/**
 * Helper to get the AndroidAdapter (typed) from DeviceManager.
 * Throws if the current platform is not android.
 */
function getAndroidAdapter(ctx: ToolContext, platform: Platform, deviceId?: string) {
  if (platform !== "android") {
    throw new Error("Clipboard tools are only available on Android platform");
  }
  return ctx.deviceManager.getAndroidClient(deviceId);
}

const deviceIdField = z
  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();

export const clipboardTools: ToolDefinition[] = [
  defineTool({
    name: "clipboard_select",
    description: "Select all text in focused field (Android only)",
    schema: z.object({ deviceId: deviceIdField }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const client = getAndroidAdapter(ctx, platform, deviceId);
      client.selectAll();
      return textResult("Selected all text in focused input field");
    },
  }),

  defineTool({
    name: "clipboard_copy",
    description: "Select all and copy to clipboard (Android only)",
    schema: z.object({ deviceId: deviceIdField }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const client = getAndroidAdapter(ctx, platform, deviceId);
      client.selectAll();
      await sleep(CLIPBOARD.POLL_MS);
      client.copyToClipboard();
      return textResult("Selected all text and copied to clipboard");
    },
  }),

  defineTool({
    name: "clipboard_paste",
    description: "Paste clipboard into focused field (Android only)",
    schema: z.object({
      fieldText: z
        .string()
        .optional()
        .describe("Find input field by text and tap to focus before pasting"),
      fieldId: z
        .string()
        .optional()
        .describe("Find input field by resource ID and tap to focus before pasting"),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const client = getAndroidAdapter(ctx, platform, deviceId);

      if (args.fieldText || args.fieldId) {
        const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
        const elements = parseUiHierarchy(xml);
        ctx.setCachedElements("android", elements);

        let found: import("../ui-tree/ui-parser.js").UiElement[] = [];
        if (args.fieldText) {
          found = findByText(elements, args.fieldText);
        } else if (args.fieldId) {
          found = findByResourceId(elements, args.fieldId);
        }

        if (found.length === 0) {
          return textResult(`Field not found: ${args.fieldText || args.fieldId}`);
        }

        const target = found[0];
        client.tap(target.centerX, target.centerY);
        await sleep(CLIPBOARD.SETTLE_MS);
      }

      client.pasteFromClipboard();
      return textResult("Pasted clipboard content into focused field");
    },
  }),

  defineTool({
    name: "clipboard_get_android",
    description: "Read clipboard text from Android device",
    schema: z.object({ deviceId: deviceIdField }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const client = getAndroidAdapter(ctx, platform, deviceId);
      const text = client.getClipboardText();
      return textResult(`Clipboard: ${text}`);
    },
  }),
];
