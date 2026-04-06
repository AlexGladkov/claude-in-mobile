import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import {
  parseUiHierarchy,
  findElements,
  formatUiTree,
  formatElement,
  analyzeScreen,
  findBestMatch,
  formatScreenAnalysis,
  desktopHierarchyToUiElements,
  UiElement,
} from "../adb/ui-parser.js";
import { DeviceNotFoundError, DeviceOfflineError, AdbNotInstalledError } from "../errors.js";

export const uiTools: ToolDefinition[] = [
  {
    tool: {
      name: "ui_tree",
      description: "Get the current UI hierarchy (accessibility tree). PREFERRED over screen_capture — text-based, ~10x cheaper in tokens. Shows all interactive elements with their text, IDs, and coordinates. Use this first for navigation, finding elements, and inspecting screen state. Note: Limited on iOS.",
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
        } catch (error: any) {
          return {
            text: `iOS UI inspection requires WebDriverAgent.\n\n` +
                  `Install: npm install -g appium && appium driver install xcuitest\n\n` +
                  `Error: ${error.message}`
          };
        }
      }

      const xml = await ctx.deviceManager.getUiHierarchyAsync(platform);

      if (currentPlatform === "desktop") {
        return { text: xml };
      }

      // Android: parse XML and format
      const parsedElements = parseUiHierarchy(xml);
      ctx.setCachedElements("android", parsedElements);
      const tree = formatUiTree(parsedElements, {
        showAll: args.showAll as boolean,
      });
      return { text: tree };
    },
  },
  {
    tool: {
      name: "ui_find",
      description: "Find UI elements by text, resource ID, or other criteria. Android: resourceId, className. iOS: label (accessibility id)",
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
            text: args.text as string,
            label: args.label as string,
            type: args.className as string,
            visible: args.visible as boolean
          });

          if (elements.length === 0) {
            return { text: "No elements found" };
          }

          const list = elements.slice(0, 20).map((el, i) =>
            `[${i}] <${el.type}> "${el.label}" @ (${el.rect.x}, ${el.rect.y})`
          ).join('\n');

          return { text: `Found ${elements.length} element(s):\n${list}` };
        } catch (error: any) {
          return {
            text: `Find element failed: ${error.message}\n\n` +
                  `Make sure WebDriverAgent is installed (see get_ui error for details)`
          };
        }
      }

      const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
      const parsedEls = parseUiHierarchy(xml);
      ctx.setCachedElements("android", parsedEls);

      const found = findElements(parsedEls, {
        text: args.text as string | undefined,
        resourceId: args.resourceId as string | undefined,
        className: args.className as string | undefined,
        clickable: args.clickable as boolean | undefined,
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
      description: "Smart tap by element description. Uses fuzzy matching to find the best element by text, content description, or resource ID, then taps it. More reliable than exact text matching. (Android only)",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "Natural language description of the element to tap, e.g., 'submit button', 'settings', 'back'" },
          minConfidence: { type: "number", description: "Minimum confidence score (0-100) to accept a match (default: 30)", default: 30 },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["description"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      if (currentPlatform !== "android") {
        return { text: "find_and_tap is only available for Android. Use tap with coordinates for iOS/Desktop." };
      }

      const description = args.description as string;
      const minConfidence = (args.minConfidence as number) ?? 30;

      const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
      const tapElements = parseUiHierarchy(xml);
      ctx.setCachedElements("android", tapElements);

      const match = findBestMatch(tapElements, description);

      if (!match) {
        return { text: `No element found matching "${description}". Try using get_ui or analyze_screen to see available elements.` };
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
      description: "Tap an element by its text content using Accessibility API. Does NOT move cursor - perfect for background automation. (Desktop/macOS only)",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to search for (partial match, case-insensitive)" },
          pid: { type: "number", description: "Process ID of the target application. Get from get_window_info." },
          exactMatch: { type: "boolean", description: "If true, requires exact text match (default: false)", default: false },
        },
        required: ["text", "pid"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      if (currentPlatform !== "desktop") {
        return { text: "tap_by_text is only available for Desktop (macOS). Use find_and_tap for Android or tap with coordinates for iOS." };
      }

      const text = args.text as string;
      const pid = args.pid as number;
      const exactMatch = (args.exactMatch as boolean) ?? false;

      if (!text) {
        return { text: "Missing required parameter: text" };
      }
      if (!pid) {
        return { text: "Missing required parameter: pid. Use get_window_info to find the process ID." };
      }

      const result = await ctx.deviceManager.getDesktopClient().tapByText(text, pid, exactMatch);

      if (result.success) {
        return {
          text: `✅ Tapped "${text}" (element: ${result.elementRole ?? "unknown"})\n` +
                `Cursor was NOT moved - background automation successful.`
        };
      } else {
        return {
          text: `❌ Failed to tap "${text}": ${result.error}`
        };
      }
    },
  },
  {
    tool: {
      name: "ui_analyze",
      description: "Get structured analysis of the current screen without taking a screenshot. Returns buttons, input fields, text content, scrollable areas, screen title, dialog detection, and navigation state. Much cheaper than screenshot for understanding screen layout.",
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

      if (currentPlatform === "android" || !currentPlatform) {
        const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
        screenElements = parseUiHierarchy(xml);
        ctx.setCachedElements("android", screenElements);

        try {
          activity = ctx.deviceManager.getAndroidClient().getCurrentActivity();
        } catch (actErr: any) {
          console.error(`[analyze_screen] Could not get current activity: ${actErr?.message}`);
        }
      } else if (currentPlatform === "ios") {
        try {
          const json = await ctx.deviceManager.getUiHierarchy("ios");
          const tree = JSON.parse(json);
          screenElements = ctx.iosTreeToUiElements(tree);
          ctx.setCachedElements("ios", screenElements);
        } catch (error: any) {
          return {
            text: `iOS UI inspection requires WebDriverAgent.\n\n` +
                  `Install: npm install -g appium && appium driver install xcuitest\n\n` +
                  `Error: ${error.message}`
          };
        }
      } else if (currentPlatform === "desktop") {
        try {
          const hierarchyText = await ctx.deviceManager.getUiHierarchyAsync("desktop");
          screenElements = desktopHierarchyToUiElements(hierarchyText);
          ctx.setCachedElements("desktop", screenElements);
        } catch (error: any) {
          return { text: `Desktop UI hierarchy not available: ${error.message}` };
        }
      } else {
        return { text: `analyze_screen is not supported for platform: ${currentPlatform}` };
      }

      const analysis = analyzeScreen(screenElements, activity);
      return { text: formatScreenAnalysis(analysis) };
    },
  },
  {
    tool: {
      name: "ui_wait",
      description: "Wait for a UI element to appear. Polls the UI hierarchy until the element is found or timeout. Much more reliable than manual wait(ms) for animations and loading.",
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
      const timeout = (args.timeout as number) ?? 5000;
      const interval = (args.interval as number) ?? 500;
      const searchText = args.text as string | undefined;
      const searchId = args.resourceId as string | undefined;
      const searchClass = args.className as string | undefined;

      if (!searchText && !searchId && !searchClass) {
        return { text: "Provide at least one search criteria: text, resourceId, or className" };
      }

      const startTime = Date.now();
      let lastElements: UiElement[] = [];

      while (Date.now() - startTime < timeout) {
        try {
          if (currentPlatform === "android") {
            const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
            lastElements = parseUiHierarchy(xml);
            ctx.setCachedElements("android", lastElements);
          } else if (currentPlatform === "ios") {
            const json = await ctx.deviceManager.getUiHierarchyAsync("ios");
            const tree = JSON.parse(json);
            lastElements = ctx.iosTreeToUiElements(tree);
          }

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
        } catch (pollErr: any) {
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
      description: "Assert that a UI element is visible on screen. Returns pass/fail without taking a screenshot. Much cheaper than visual verification.",
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
      const searchText = args.text as string | undefined;
      const searchId = args.resourceId as string | undefined;

      if (!searchText && !searchId) {
        return { text: "Provide text or resourceId to assert" };
      }

      let elements: UiElement[] = [];
      if (currentPlatform === "android") {
        const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
        elements = parseUiHierarchy(xml);
        ctx.setCachedElements("android", elements);
      } else if (currentPlatform === "ios") {
        const json = await ctx.deviceManager.getUiHierarchyAsync("ios");
        const tree = JSON.parse(json);
        elements = ctx.iosTreeToUiElements(tree);
      }

      const found = findElements(elements, {
        text: searchText,
        resourceId: searchId,
      });

      if (found.length > 0) {
        return { text: `PASS: Element visible — ${formatElement(found[0])}` };
      }
      return { text: `FAIL: Element not visible (text=${searchText ?? ""}, resourceId=${searchId ?? ""})` };
    },
  },
  {
    tool: {
      name: "ui_assert_gone",
      description: "Assert that a UI element does NOT exist on screen. Useful for verifying elements were removed, dialogs dismissed, etc.",
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
      const searchText = args.text as string | undefined;
      const searchId = args.resourceId as string | undefined;

      if (!searchText && !searchId) {
        return { text: "Provide text or resourceId to assert absence" };
      }

      let elements: UiElement[] = [];
      if (currentPlatform === "android") {
        const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
        elements = parseUiHierarchy(xml);
        ctx.setCachedElements("android", elements);
      } else if (currentPlatform === "ios") {
        const json = await ctx.deviceManager.getUiHierarchyAsync("ios");
        const tree = JSON.parse(json);
        elements = ctx.iosTreeToUiElements(tree);
      }

      const found = findElements(elements, {
        text: searchText,
        resourceId: searchId,
      });

      if (found.length === 0) {
        return { text: `PASS: Element not present (text=${searchText ?? ""}, resourceId=${searchId ?? ""})` };
      }
      return { text: `FAIL: Element exists — ${formatElement(found[0])}` };
    },
  },
];
