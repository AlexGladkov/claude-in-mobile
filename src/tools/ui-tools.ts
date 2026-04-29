import type { ToolDefinition } from "./registry.js";
import type { Platform } from "../device-manager.js";
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
import { getString, getNumber, getBoolean, requireString } from "./helpers/args-parser.js";

export const uiTools: ToolDefinition[] = [
  {
    tool: {
      name: "ui_tree",
      description: "Get UI hierarchy (accessibility tree). Shows elements, text, IDs, coordinates.",
      inputSchema: {
        type: "object",
        properties: {
          showAll: { type: "boolean", description: "Show all elements including non-interactive ones", default: false },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      if (currentPlatform === "ios") {
        try {
          const json = await ctx.deviceManager.getUiHierarchy("ios");
          const tree = JSON.parse(json);
          const formatted = ctx.formatIOSUITree(tree);
          return { text: formatted };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            text: `iOS UI inspection requires WebDriverAgent.\n\n` +
                  `Install: npm install -g appium && appium driver install xcuitest\n\n` +
                  `Error: ${msg}`
          };
        }
      }

      const xml = await ctx.deviceManager.getUiHierarchyAsync(platform);

      if (currentPlatform === "desktop") {
        const { truncateOutput } = await import("../utils/truncate.js");
        return { text: truncateOutput(xml, { maxChars: 15_000 }) };
      }

      // Android: parse XML and format
      const parsedElements = parseUiHierarchy(xml);
      ctx.setCachedElements("android", parsedElements);
      // Semantic format — grouped by role, ~3x token reduction
      const format = getString(args, "format");
      if (format === "semantic") {
        return { text: formatUiTreeSemantic(parsedElements) };
      }

      const showAll = getBoolean(args, "showAll");
      const compact = getBoolean(args, "compact");
      const tree = formatUiTree(parsedElements, { showAll, compact });

      // Dedup cache: if identical output within 2s, return short notice
      const fresh = getBoolean(args, "fresh");
      const cacheKey = `android:${showAll}:${compact}`;
      const cached = fresh ? undefined : ctx.lastUiTreeMap.get(cacheKey);
      const now = Date.now();
      if (cached && cached.text === tree && (now - cached.timestamp) < 2000) {
        const ago = now - cached.timestamp;
        return { text: `UI unchanged (cached ${ago}ms ago). ${parsedElements.length} elements.` };
      }
      ctx.lastUiTreeMap.set(cacheKey, { text: tree, timestamp: now });

      return { text: tree };
    },
  },
  {
    tool: {
      name: "ui_find",
      description: "Find UI elements by text, resourceId, className, or label",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Find by text (partial match, case-insensitive)" },
          label: { type: "string", description: "iOS: Find by accessibility label" },
          resourceId: { type: "string", description: "Android: Find by resource ID (partial match)" },
          className: { type: "string", description: "Find by class name (Android: full class, iOS: XCUIElementType*)" },
          clickable: { type: "boolean", description: "Android: Filter by clickable state" },
          visible: { type: "boolean", description: "iOS: Filter by visibility" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      if (currentPlatform === "ios") {
        try {
          const iosClient = ctx.deviceManager.getIosClient();
          const elements = await iosClient.findElements({
            text: getString(args, "text"),
            label: getString(args, "label"),
            type: getString(args, "className"),
            visible: typeof args.visible === "boolean" ? args.visible : undefined,
          });

          if (elements.length === 0) {
            return { text: "No elements found" };
          }

          const list = elements.slice(0, 20).map((el, i) =>
            `[${i}] <${el.type}> "${el.label}" @ (${el.rect.x}, ${el.rect.y})`
          ).join('\n');

          return { text: `Found ${elements.length} element(s):\n${list}` };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          return {
            text: `Find element failed: ${msg}\n\n` +
                  `Make sure WebDriverAgent is installed (see get_ui error for details)`
          };
        }
      }

      const { elements: parsedEls } = await getUiElements(ctx, "android");

      const found = findElements(parsedEls, {
        text: getString(args, "text"),
        resourceId: getString(args, "resourceId"),
        className: getString(args, "className"),
        clickable: typeof args.clickable === "boolean" ? args.clickable : undefined,
      });

      if (found.length === 0) {
        return { text: "No elements found matching criteria" };
      }

      const list = found.slice(0, 20).map(formatElement).join("\n");
      return { text: `Found ${found.length} element(s):\n${list}${found.length > 20 ? "\n..." : ""}` };
    },
  },
  {
    tool: {
      name: "ui_find_tap",
      description: "Fuzzy tap by natural language element description (Android only)",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Natural language description of the element to tap, e.g., 'submit button', 'settings', 'back'" },
          minConfidence: { type: "number", description: "Minimum confidence score (0-100) to accept a match (default: 30)", default: 30 },
        },
        required: ["description"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      if (currentPlatform !== "android") {
        return { text: "ui(action:'find_tap') is only available for Android. Use tap with coordinates for iOS/Desktop." };
      }

      const description = requireString(args, "description");
      const minConfidence = getNumber(args, "minConfidence") ?? 30;

      const { elements: tapElements } = await getUiElements(ctx, "android");

      const match = findBestMatch(tapElements, description);

      if (!match) {
        return { text: `No element found matching "${description}". Try using ui(action:'tree') or ui(action:'analyze') to see available elements.` };
      }

      if (match.confidence < minConfidence) {
        return {
          text: `Best match has low confidence (${match.confidence}%): ${match.reason}\n` +
                `Element: ${formatElement(match.element)}\n` +
                `Set minConfidence lower or use tap with coordinates.`
        };
      }

      await ctx.deviceManager.tap(match.element.centerX, match.element.centerY, "android");

      return {
        text: `Tapped "${description}" (${match.confidence}% confidence)\n` +
              `Match: ${match.reason}\n` +
              `Coordinates: (${match.element.centerX}, ${match.element.centerY})`
      };
    },
  },
  {
    tool: {
      name: "ui_tap_text",
      description: "Tap element by text via Accessibility API (Desktop/macOS only)",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to search for (partial match, case-insensitive)" },
          pid: { type: "number", description: "Process ID of the target application. Get from get_window_info. Optional if a native app was launched/attached." },
          exactMatch: { type: "boolean", description: "If true, requires exact text match (default: false)", default: false },
        },
        required: ["text"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      if (currentPlatform !== "desktop") {
        return { text: "ui(action:'tap_text') is only available for Desktop (macOS). Use ui(action:'find_tap') for Android or input(action:'tap') with coordinates for iOS." };
      }

      const text = requireString(args, "text");
      const pid = getNumber(args, "pid");
      const exactMatch = getBoolean(args, "exactMatch");

      const result = await ctx.deviceManager.getDesktopClient().tapByText(text, pid, exactMatch);

      if (result.success) {
        return {
          text: `OK: Tapped "${text}" (element: ${result.elementRole ?? "unknown"})\n` +
                `Cursor was NOT moved - background automation successful.`
        };
      } else {
        return {
          text: `FAIL: Failed to tap "${text}": ${result.error}`
        };
      }
    },
  },
  {
    tool: {
      name: "ui_analyze",
      description: "Structured screen analysis: buttons, inputs, text, scrollable areas, dialogs",
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
      let screenElements: UiElement[] = [];
      let activity: string | undefined;

      try {
        const result = await getUiElements(ctx, currentPlatform);
        screenElements = result.elements;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        if (currentPlatform === "ios") {
          return {
            text: `iOS UI inspection requires WebDriverAgent.\n\n` +
                  `Install: npm install -g appium && appium driver install xcuitest\n\n` +
                  `Error: ${msg}`
          };
        }
        if (currentPlatform === "desktop") {
          return { text: `Desktop UI hierarchy not available: ${msg}` };
        }
        throw error;
      }

      if (currentPlatform === "android" || !currentPlatform) {
        try {
          activity = ctx.deviceManager.getAndroidClient().getCurrentActivity();
        } catch (actErr: unknown) {
          const actMsg = actErr instanceof Error ? actErr.message : String(actErr);
          console.error(`[analyze_screen] Could not get current activity: ${actMsg}`);
        }
      }

      if (!currentPlatform || !["android", "ios", "desktop"].includes(currentPlatform)) {
        if (currentPlatform) {
          return { text: `ui(action:'analyze') is not supported for platform: ${currentPlatform}` };
        }
      }

      const analysis = analyzeScreen(screenElements, activity);
      return { text: formatScreenAnalysis(analysis) };
    },
  },
  {
    tool: {
      name: "ui_wait",
      description: "Wait for UI element to appear (polling with timeout)",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Element text to wait for (partial match, case-insensitive)" },
          resourceId: { type: "string", description: "Android: resource ID to wait for (partial match)" },
          className: { type: "string", description: "Class name to wait for" },
          timeout: { type: "number", description: "Max wait time in ms (default: 5000)", default: 5000 },
          interval: { type: "number", description: "Poll interval in ms (default: 500)", default: 500 },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();
      const timeout = getNumber(args, "timeout") ?? 5000;
      const interval = getNumber(args, "interval") ?? 500;
      const searchText = getString(args, "text");
      const searchId = getString(args, "resourceId");
      const searchClass = getString(args, "className");

      if (!searchText && !searchId && !searchClass) {
        return { text: "Provide at least one search criteria: text, resourceId, or className" };
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
            return {
              text: `Element found after ${elapsed}ms:\n${formatElement(found[0])}\n` +
                    (found.length > 1 ? `(${found.length} total matches)` : "")
            };
          }
        } catch (pollErr: unknown) {
          if (pollErr instanceof DeviceNotFoundError || pollErr instanceof DeviceOfflineError || pollErr instanceof AdbNotInstalledError) {
            throw pollErr;
          }
        }

        await new Promise(resolve => setTimeout(resolve, interval));
      }

      return { text: `Timeout after ${timeout}ms: element not found (text=${searchText ?? ""}, resourceId=${searchId ?? ""}, className=${searchClass ?? ""})` };
    },
  },
  {
    tool: {
      name: "ui_assert_visible",
      description: "Assert element is visible on screen (pass/fail)",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Element text to check for (partial match)" },
          resourceId: { type: "string", description: "Android: resource ID to check for" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();
      const searchText = getString(args, "text");
      const searchId = getString(args, "resourceId");

      if (!searchText && !searchId) {
        return { text: "Provide text or resourceId to assert" };
      }

      const { elements } = await getUiElements(ctx, currentPlatform);

      const found = findElements(elements, {
        text: searchText,
        resourceId: searchId,
      });

      if (found.length > 0) {
        return { text: `PASS: Element visible -- ${formatElement(found[0])}` };
      }
      return { text: `FAIL: Element not visible (text=${searchText ?? ""}, resourceId=${searchId ?? ""})`, isError: true };
    },
  },
  {
    tool: {
      name: "ui_assert_gone",
      description: "Assert element does NOT exist on screen (pass/fail)",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Element text that should NOT be present" },
          resourceId: { type: "string", description: "Android: resource ID that should NOT be present" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();
      const searchText = getString(args, "text");
      const searchId = getString(args, "resourceId");

      if (!searchText && !searchId) {
        return { text: "Provide text or resourceId to assert absence" };
      }

      const { elements } = await getUiElements(ctx, currentPlatform);

      const found = findElements(elements, {
        text: searchText,
        resourceId: searchId,
      });

      if (found.length === 0) {
        return { text: `PASS: Element not present (text=${searchText ?? ""}, resourceId=${searchId ?? ""})` };
      }
      return { text: `FAIL: Element exists -- ${formatElement(found[0])}`, isError: true };
    },
  },
];
