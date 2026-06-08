import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import {
  parseUiHierarchy,
  findElements,
  formatUiTree,
  formatUiTreeSemantic,
  formatElement,
  analyzeScreen,
  findBestMatch,
  formatScreenAnalysis,
  UiElement,
} from "../adb/ui-parser.js";
import { DeviceNotFoundError, DeviceOfflineError, AdbNotInstalledError } from "../errors.js";
import { getUiElements } from "./helpers/get-elements.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult, errorResult } from "../utils/tool-result.js";
import { sleep } from "../utils/sleep.js";

const platformEnum = z
  .enum(["android", "ios", "desktop", "aurora", "browser"])
  .describe("Target platform. If not specified, uses the active target.")
  .optional();

const deviceIdField = z
  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();

export const uiTools: ToolDefinition[] = [
  defineTool({
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
        const { truncateOutput } = await import("../utils/truncate.js");
        return textResult(truncateOutput(xml, { maxChars: 15_000 }));
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
  }),

  defineTool({
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
  }),

  defineTool({
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
  }),

  defineTool({
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
  }),

  defineTool({
    name: "ui_analyze",
    description: "Structured screen analysis: buttons, inputs, text, scrollable areas, dialogs",
    schema: z.object({
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      let screenElements: UiElement[] = [];
      let activity: string | undefined;

      try {
        const result = await getUiElements(ctx, currentPlatform);
        screenElements = result.elements;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        if (currentPlatform === "ios") {
          return textResult(
            `iOS UI inspection requires WebDriverAgent.\n\n` +
              `Install: npm install -g appium && appium driver install xcuitest\n\n` +
              `Error: ${msg}`,
          );
        }
        if (currentPlatform === "desktop") {
          return textResult(`Desktop UI hierarchy not available: ${msg}`);
        }
        throw error;
      }

      if (currentPlatform === "android" || !currentPlatform) {
        try {
          activity = ctx.deviceManager.getAndroidClient(deviceId).getCurrentActivity();
        } catch (actErr: unknown) {
          const actMsg = actErr instanceof Error ? actErr.message : String(actErr);
          console.error(`[analyze_screen] Could not get current activity: ${actMsg}`);
        }
      }

      if (!currentPlatform || !["android", "ios", "desktop"].includes(currentPlatform)) {
        if (currentPlatform) {
          return textResult(`ui(action:'analyze') is not supported for platform: ${currentPlatform}`);
        }
      }

      const analysis = analyzeScreen(screenElements, activity);
      return textResult(formatScreenAnalysis(analysis));
    },
  }),

  defineTool({
    name: "ui_wait",
    description: "Wait for UI element to appear (polling with timeout)",
    schema: z.object({
      text: z.string().optional().describe("Element text to wait for (partial match, case-insensitive)"),
      resourceId: z.string().optional().describe("Android: resource ID to wait for (partial match)"),
      className: z.string().optional().describe("Class name to wait for"),
      timeout: z.number().default(5000).describe("Max wait time in ms (default: 5000)"),
      interval: z.number().default(500).describe("Poll interval in ms (default: 500)"),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const timeout = args.timeout;
      const interval = args.interval;
      const searchText = args.text;
      const searchId = args.resourceId;
      const searchClass = args.className;

      if (!searchText && !searchId && !searchClass) {
        return textResult("Provide at least one search criteria: text, resourceId, or className");
      }

      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        try {
          const { elements: lastElements } = await getUiElements(ctx, currentPlatform);

          const found = findElements(lastElements, {
            text: searchText,
            resourceId: searchId,
            className: searchClass,
          });

          if (found.length > 0) {
            const elapsed = Date.now() - startTime;
            return textResult(
              `Element found after ${elapsed}ms:\n${formatElement(found[0])}\n` +
                (found.length > 1 ? `(${found.length} total matches)` : ""),
            );
          }
        } catch (pollErr: unknown) {
          if (pollErr instanceof DeviceNotFoundError || pollErr instanceof DeviceOfflineError || pollErr instanceof AdbNotInstalledError) {
            throw pollErr;
          }
        }

        await sleep(interval);
      }

      return textResult(
        `Timeout after ${timeout}ms: element not found (text=${searchText ?? ""}, resourceId=${searchId ?? ""}, className=${searchClass ?? ""})`,
      );
    },
  }),

  defineTool({
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
  }),

  defineTool({
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
  }),
];
