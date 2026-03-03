import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { parseUiHierarchy, findByText, findByResourceId } from "../adb/ui-parser.js";

/**
 * Helper to get the AndroidAdapter (typed) from DeviceManager.
 * Throws if the current platform is not android.
 */
function getAndroidAdapter(ctx: ToolContext, platform?: Platform) {
  const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();
  if (currentPlatform !== "android") {
    throw new Error("Clipboard tools are only available on Android platform");
  }
  // getAndroidClient() returns AdbClient which has the clipboard methods
  return ctx.deviceManager.getAndroidClient();
}

export const clipboardTools: ToolDefinition[] = [
  {
    tool: {
      name: "select_text",
      description: "Select all text in the currently focused input field (Android only)",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const client = getAndroidAdapter(ctx, platform);
      client.selectAll();
      return { text: "Selected all text in focused input field" };
    },
  },
  {
    tool: {
      name: "copy_text",
      description: "Select all text and copy to clipboard (Android only)",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const client = getAndroidAdapter(ctx, platform);
      client.selectAll();
      await new Promise(resolve => setTimeout(resolve, 100));
      client.copyToClipboard();
      return { text: "Selected all text and copied to clipboard" };
    },
  },
  {
    tool: {
      name: "paste_text",
      description: "Paste clipboard content into focused field. Optionally find a field by text or resource ID and tap to focus it first (Android only)",
      inputSchema: {
        type: "object",
        properties: {
          fieldText: { type: "string", description: "Find input field by text and tap to focus before pasting" },
          fieldId: { type: "string", description: "Find input field by resource ID and tap to focus before pasting" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const client = getAndroidAdapter(ctx, platform);

      // Optionally find and tap the target field first
      if (args.fieldText || args.fieldId) {
        const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
        const elements = parseUiHierarchy(xml);
        ctx.setCachedElements("android", elements);

        let found: import("../adb/ui-parser.js").UiElement[] = [];
        if (args.fieldText) {
          found = findByText(elements, args.fieldText as string);
        } else if (args.fieldId) {
          found = findByResourceId(elements, args.fieldId as string);
        }

        if (found.length === 0) {
          return { text: `Field not found: ${args.fieldText || args.fieldId}` };
        }

        const target = found[0];
        client.tap(target.centerX, target.centerY);
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      client.pasteFromClipboard();
      return { text: "Pasted clipboard content into focused field" };
    },
  },
  {
    tool: {
      name: "get_clipboard_android",
      description: "Read clipboard text from Android device (requires API 29+ or clipper app)",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const client = getAndroidAdapter(ctx, platform);
      const text = client.getClipboardText();
      return { text: `Clipboard: ${text}` };
    },
  },
];
