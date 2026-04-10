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
      name: "clipboard_select",
      description: "Select all text in the currently focused input field (Android only, non-Sonic)",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;

      // Sonic mode: clipboard_select is not supported (requires ADB-specific functionality)
      if (ctx.deviceManager.isSonicMode()) {
        return { content: [{ type: "text", text: "clipboard_select is not supported in Sonic mode. Use input_text to enter text directly." }] };
      }

      const client = getAndroidAdapter(ctx, platform);
      client.selectAll();
      return { text: "Selected all text in focused input field" };
    },
  },
  {
    tool: {
      name: "clipboard_copy",
      description: "Select all text and copy to clipboard (Android non-Sonic only)",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;

      // Sonic mode: clipboard_copy is not supported (requires ADB-specific functionality)
      if (ctx.deviceManager.isSonicMode()) {
        return { content: [{ type: "text", text: "clipboard_copy is not supported in Sonic mode. Use clipboard_get_android to read clipboard content." }] };
      }

      const client = getAndroidAdapter(ctx, platform);
      client.selectAll();
      await new Promise(resolve => setTimeout(resolve, 100));
      client.copyToClipboard();
      return { text: "Selected all text and copied to clipboard" };
    },
  },
  {
    tool: {
      name: "clipboard_paste",
      description: "Paste clipboard content into focused field. Optionally find a field by text or resource ID and tap to focus it first (Android non-Sonic only)",
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

      // Sonic mode: clipboard_paste is not supported (requires ADB-specific functionality)
      if (ctx.deviceManager.isSonicMode()) {
        return { content: [{ type: "text", text: "clipboard_paste is not supported in Sonic mode. Use input_text to enter text directly." }] };
      }

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
      name: "clipboard_get_android",
      description: "Read clipboard text from Android or iOS device (supports both ADB and Sonic modes)",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      // Sonic mode support for Android and iOS - use DeviceManager delegation
      if (ctx.deviceManager.isSonicMode() && (currentPlatform === "android" || currentPlatform === "ios")) {
        const text = await ctx.deviceManager.getClipboard(platform);
        return { content: [{ type: "text", text: `Clipboard: ${text}` }] };
      }

      // Original ADB implementation for Android (non-Sonic)
      if (currentPlatform !== "android") {
        return { content: [{ type: "text", text: "clipboard_get_android is only available on Android platform in non-Sonic mode" }] };
      }

      const client = getAndroidAdapter(ctx, platform);
      const text = client.getClipboardText();
      return { content: [{ type: "text", text: `Clipboard: ${text}` }] };
    },
  },
  {
    tool: {
      name: "clipboard_set",
      description: "Set clipboard text on Android or iOS device (supports both ADB and Sonic modes)",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to set in clipboard" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["text"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();
      const text = args.text as string;

      // Sonic mode support for Android and iOS - use DeviceManager delegation
      if (ctx.deviceManager.isSonicMode() && (currentPlatform === "android" || currentPlatform === "ios")) {
        await ctx.deviceManager.setClipboard(text, platform);
        return { content: [{ type: "text", text: `Clipboard set to: ${text}` }] };
      }

      // ADB implementation for Android (non-Sonic)
      if (currentPlatform === "android") {
        const client = getAndroidAdapter(ctx, platform);
        client.setClipboardText(text);
        return { content: [{ type: "text", text: `Clipboard set to: ${text}` }] };
      }

      return { content: [{ type: "text", text: `clipboard_set is not supported for ${currentPlatform} in non-Sonic mode` }] };
    },
  },
];
