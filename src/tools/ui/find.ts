import { defineTool, z } from "../define-tool.js";
import { platformEnum, deviceIdField } from "../common-schema.js";
import { findElements, formatElement, findBestMatch } from "../../adb/ui-parser.js";
import { getUiElements } from "../helpers/get-elements.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult } from "../../utils/tool-result.js";

export const uiFind = defineTool({
  name: "ui_find",
  description: "Find UI elements by text, resourceId, className, or label",
  schema: z.object({
    text: z.string().optional().describe("Find by text (partial match, case-insensitive)"),
    label: z.string().optional().describe("iOS: Find by accessibility label"),
    resourceId: z.string().optional().describe("Android: Find by resource ID (partial match)"),
    className: z.string().optional().describe("Find by class name (Android: full class, iOS: XCUIElementType*)"),
    clickable: z.boolean().optional().describe("Android: Filter by clickable state"),
    visible: z.boolean().optional().describe("iOS: Filter by visibility"),
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);

    if (currentPlatform === "ios") {
      try {
        const iosClient = ctx.deviceManager.getIosClient(deviceId);
        const elements = await iosClient.findElements({
          text: args.text,
          label: args.label,
          type: args.className,
          visible: args.visible,
        });

        if (elements.length === 0) {
          return textResult("No elements found");
        }

        const list = elements.slice(0, 20).map((el, i) =>
          `[${i}] <${el.type}> "${el.label}" @ (${el.rect.x}, ${el.rect.y})`,
        ).join("\n");

        return textResult(`Found ${elements.length} element(s):\n${list}`);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return textResult(
          `Find element failed: ${msg}\n\n` +
            `Make sure WebDriverAgent is installed (see get_ui error for details)`,
        );
      }
    }

    const { elements: parsedEls } = await getUiElements(ctx, "android");

    const found = findElements(parsedEls, {
      text: args.text,
      resourceId: args.resourceId,
      className: args.className,
      clickable: args.clickable,
    });

    if (found.length === 0) {
      return textResult("No elements found matching criteria");
    }

    const list = found.slice(0, 20).map(formatElement).join("\n");
    return textResult(`Found ${found.length} element(s):\n${list}${found.length > 20 ? "\n..." : ""}`);
  },
});

export const uiFindTap = defineTool({
  name: "ui_find_tap",
  description:
    "Fuzzy tap by natural language element description (Android only). When the matched element is a non-clickable label (common in grid/list items where the parent ViewGroup owns the gesture), walks up to the smallest containing clickable ancestor by default — set walkToClickable=false to tap the matched element directly.",
  schema: z.object({
    description: z
      .string()
      .describe("Natural language description of the element to tap, e.g., 'submit button', 'settings', 'back'"),
    minConfidence: z
      .number()
      .default(30)
      .describe("Minimum confidence score (0-100) to accept a match (default: 30)"),
    walkToClickable: z
      .boolean()
      .default(true)
      .describe(
        "If matched element is non-clickable (e.g., a TextView label), walk up to the smallest containing clickable ancestor. Default true. Set false to tap the matched element directly even if non-clickable (rare).",
      ),
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);

    if (currentPlatform !== "android") {
      return textResult("ui(action:'find_tap') is only available for Android. Use tap with coordinates for iOS/Desktop.");
    }

    const description = args.description;
    const minConfidence = args.minConfidence;
    const walkToClickable = args.walkToClickable;

    const { elements: tapElements } = await getUiElements(ctx, "android");

    const match = findBestMatch(tapElements, description, { walkToClickable });

    if (!match) {
      return textResult(
        `No element found matching "${description}". Try using ui(action:'tree') or ui(action:'analyze') to see available elements.`,
      );
    }

    if (match.confidence < minConfidence) {
      return textResult(
        `Best match has low confidence (${match.confidence}%): ${match.reason}\n` +
          `Element: ${formatElement(match.element)}\n` +
          `Set minConfidence lower or use tap with coordinates.`,
      );
    }

    await ctx.deviceManager.tap(match.element.centerX, match.element.centerY, "android", undefined, deviceId);

    return textResult(
      `Tapped "${description}" (${match.confidence}% confidence)\n` +
        `Match: ${match.reason}\n` +
        `Coordinates: (${match.element.centerX}, ${match.element.centerY})`,
    );
  },
});

export const uiTapText = defineTool({
  name: "ui_tap_text",
  description: "Tap element by text via Accessibility API (Desktop/macOS only)",
  schema: z.object({
    text: z.string().describe("Text to search for (partial match, case-insensitive)"),
    pid: z
      .number()
      .optional()
      .describe(
        "Process ID of the target application. Get from get_window_info. Optional if a native app was launched/attached.",
      ),
    exactMatch: z.boolean().default(false).describe("If true, requires exact text match (default: false)"),
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);

    if (currentPlatform !== "desktop") {
      return textResult(
        "ui(action:'tap_text') is only available for Desktop (macOS). Use ui(action:'find_tap') for Android or input(action:'tap') with coordinates for iOS.",
      );
    }

    const text = args.text;
    const pid = args.pid;
    const exactMatch = args.exactMatch;

    const result = await ctx.deviceManager.getDesktopClient().tapByText(text, pid, exactMatch);

    if (result.success) {
      return textResult(
        `OK: Tapped "${text}" (element: ${result.elementRole ?? "unknown"})\n` +
          `Cursor was NOT moved - background automation successful.`,
      );
    }
    return textResult(`FAIL: Failed to tap "${text}": ${result.error}`);
  },
});
