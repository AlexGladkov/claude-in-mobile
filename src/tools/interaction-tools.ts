import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { parseUiHierarchy, findByText, findByResourceId } from "../adb/ui-parser.js";
import { ElementNotFoundError } from "../errors.js";

/** Apply screenshot scale to raw coordinates from Claude (image space → device space). */
function applyScale(
  x: number,
  y: number,
  platform: string | undefined,
  ctx: ToolContext,
): { x: number; y: number } {
  const key = platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";
  const scale = ctx.screenshotScaleMap.get(key);
  if (!scale || (scale.scaleX === 1 && scale.scaleY === 1)) return { x, y };
  return {
    x: Math.round(x * scale.scaleX),
    y: Math.round(y * scale.scaleY),
  };
}

export const interactionTools: ToolDefinition[] = [
  {
    tool: {
      name: "input_tap",
      description: "Tap at specific coordinates or find an element by text/id and tap it",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate to tap" },
          y: { type: "number", description: "Y coordinate to tap" },
          text: { type: "string", description: "Android: Element text. iOS: Element name (less reliable than label)" },
          label: { type: "string", description: "iOS only: Accessibility label (most reliable)" },
          resourceId: { type: "string", description: "Find element with this resource ID and tap it (Android only)" },
          index: { type: "number", description: "Tap element by index from get_ui output (Android only)" },
          targetPid: { type: "number", description: "Desktop only: PID of target process. When provided, sends tap without stealing window focus." },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screenshot/get_ui.", default: false },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      let x: number | undefined = args.x as number;
      let y: number | undefined = args.y as number;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();
      let coordsFromArgs = x !== undefined && y !== undefined;

      // iOS element-based tap (precedence: label > text > coordinates)
      if (currentPlatform === "ios" && (args.label || args.text)) {
        try {
          const iosClient = ctx.deviceManager.getIosClient();
          const element = await iosClient.findElement({
            text: args.text as string,
            label: args.label as string
          });
          await iosClient.tapElement(element.ELEMENT);
          return { text: `Tapped element: ${args.label || args.text}` };
        } catch (error: any) {
          throw new ElementNotFoundError(String(args.label || args.text));
        }
      }

      // Find by index from cached elements (Android only) — device coords, no scale needed
      if (args.index !== undefined && currentPlatform === "android") {
        const idx = args.index as number;
        let elements = ctx.getCachedElements("android");
        if (elements.length === 0) {
          const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
          elements = parseUiHierarchy(xml);
          ctx.setCachedElements("android", elements);
        }
        const el = elements.find(e => e.index === idx);
        if (!el) {
          return { text: `Element with index ${idx} not found. Run get_ui first.` };
        }
        x = el.centerX;
        y = el.centerY;
        coordsFromArgs = false;
      }

      // Find by text or resourceId (Android only) — device coords, no scale needed
      if ((args.text || args.resourceId) && currentPlatform === "android") {
        const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
        const elements = parseUiHierarchy(xml);
        ctx.setCachedElements("android", elements);

        let found: import("../adb/ui-parser.js").UiElement[] = [];
        if (args.text) {
          found = findByText(elements, args.text as string);
        } else if (args.resourceId) {
          found = findByResourceId(elements, args.resourceId as string);
        }

        if (found.length === 0) {
          throw new ElementNotFoundError(String(args.text || args.resourceId));
        }

        const clickable = found.filter(el => el.clickable);
        const target = clickable[0] ?? found[0];
        x = target.centerX;
        y = target.centerY;
        coordsFromArgs = false;
      }

      if (x === undefined || y === undefined) {
        return { text: "Please provide x,y coordinates, text, resourceId, label, or index" };
      }

      // Scale raw screenshot coordinates → device coordinates
      if (coordsFromArgs) ({ x, y } = applyScale(x, y, currentPlatform ?? undefined, ctx));

      const targetPid = args.targetPid as number | undefined;
      await ctx.deviceManager.tap(x, y, platform, targetPid);
      let result = `Tapped at (${x}, ${y})`;
      if (args.hints === true) {
        result += await ctx.generateActionHints(platform as string | undefined);
      }
      return { text: result };
    },
  },
  {
    tool: {
      name: "input_double_tap",
      description: "Double tap at specific coordinates or find an element by text/id and double tap it",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate to tap" },
          y: { type: "number", description: "Y coordinate to tap" },
          text: { type: "string", description: "Find element by text and double tap it (Android only)" },
          resourceId: { type: "string", description: "Find element with this resource ID and double tap it (Android only)" },
          index: { type: "number", description: "Double tap element by index from get_ui output (Android only)" },
          interval: { type: "number", description: "Delay between taps in milliseconds (default: 100)", default: 100 },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screenshot/get_ui.", default: false },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      let x: number | undefined = args.x as number;
      let y: number | undefined = args.y as number;
      const interval = (args.interval as number) ?? 100;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();
      let coordsFromArgs = x !== undefined && y !== undefined;

      // Find by index from cached elements (Android only) — device coords, no scale needed
      if (args.index !== undefined && currentPlatform === "android") {
        const idx = args.index as number;
        let elements = ctx.getCachedElements("android");
        if (elements.length === 0) {
          const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
          elements = parseUiHierarchy(xml);
          ctx.setCachedElements("android", elements);
        }
        const el = elements.find(e => e.index === idx);
        if (!el) {
          return { text: `Element with index ${idx} not found. Run get_ui first.` };
        }
        x = el.centerX;
        y = el.centerY;
        coordsFromArgs = false;
      }

      // Find by text or resourceId (Android only) — device coords, no scale needed
      if ((args.text || args.resourceId) && currentPlatform === "android") {
        const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
        const elements = parseUiHierarchy(xml);
        ctx.setCachedElements("android", elements);

        let found: import("../adb/ui-parser.js").UiElement[] = [];
        if (args.text) {
          found = findByText(elements, args.text as string);
        } else if (args.resourceId) {
          found = findByResourceId(elements, args.resourceId as string);
        }

        if (found.length === 0) {
          throw new ElementNotFoundError(String(args.text || args.resourceId));
        }

        const clickable = found.filter(el => el.clickable);
        const target = clickable[0] ?? found[0];
        x = target.centerX;
        y = target.centerY;
        coordsFromArgs = false;
      }

      if (x === undefined || y === undefined) {
        return { text: "Please provide x,y coordinates, text, resourceId, or index" };
      }

      if (coordsFromArgs) ({ x, y } = applyScale(x, y, currentPlatform ?? undefined, ctx));

      await ctx.deviceManager.doubleTap(x, y, interval, platform);
      let result = `Double tapped at (${x}, ${y}) with ${interval}ms interval`;
      if (args.hints === true) {
        result += await ctx.generateActionHints(platform as string | undefined);
      }
      return { text: result };
    },
  },
  {
    tool: {
      name: "input_long_press",
      description: "Long press at coordinates or on an element",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate" },
          y: { type: "number", description: "Y coordinate" },
          text: { type: "string", description: "Find element by text (Android only)" },
          duration: { type: "number", description: "Duration in milliseconds (default: 1000)", default: 1000 },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      let x: number | undefined = args.x as number;
      let y: number | undefined = args.y as number;
      const duration = (args.duration as number) ?? 1000;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      let coordsFromArgs = x !== undefined && y !== undefined;

      if (args.text && currentPlatform === "android") {
        const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
        const elements = parseUiHierarchy(xml);
        ctx.setCachedElements("android", elements);
        const found = findByText(elements, args.text as string);
        if (found.length === 0) {
          throw new ElementNotFoundError(String(args.text));
        }
        x = found[0].centerX;
        y = found[0].centerY;
        coordsFromArgs = false;
      }

      if (x === undefined || y === undefined) {
        return { text: "Please provide x,y coordinates or text" };
      }

      if (coordsFromArgs) ({ x, y } = applyScale(x, y, currentPlatform ?? undefined, ctx));

      await ctx.deviceManager.longPress(x, y, duration, platform);
      return { text: `Long pressed at (${x}, ${y}) for ${duration}ms` };
    },
  },
  {
    tool: {
      name: "input_swipe",
      description: "Perform a swipe gesture",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Swipe direction" },
          x1: { type: "number", description: "Start X (for custom swipe)" },
          y1: { type: "number", description: "Start Y (for custom swipe)" },
          x2: { type: "number", description: "End X (for custom swipe)" },
          y2: { type: "number", description: "End Y (for custom swipe)" },
          duration: { type: "number", description: "Duration in ms (default: 300)", default: 300 },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screenshot/get_ui.", default: false },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;

      if (args.direction) {
        await ctx.deviceManager.swipeDirection(args.direction as "up" | "down" | "left" | "right", platform);
        let result = `Swiped ${args.direction}`;
        if (args.hints === true) {
          result += await ctx.generateActionHints(platform as string | undefined);
        }
        return { text: result };
      }

      if (args.x1 !== undefined && args.y1 !== undefined &&
          args.x2 !== undefined && args.y2 !== undefined) {
        const duration = (args.duration as number) ?? 300;
        const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();
        const p1 = applyScale(args.x1 as number, args.y1 as number, currentPlatform ?? undefined, ctx);
        const p2 = applyScale(args.x2 as number, args.y2 as number, currentPlatform ?? undefined, ctx);
        await ctx.deviceManager.swipe(p1.x, p1.y, p2.x, p2.y, duration, platform);
        let result = `Swiped from (${p1.x}, ${p1.y}) to (${p2.x}, ${p2.y})`;
        if (args.hints === true) {
          result += await ctx.generateActionHints(platform as string | undefined);
        }
        return { text: result };
      }

      return { text: "Please provide direction or x1,y1,x2,y2 coordinates" };
    },
  },
  {
    tool: {
      name: "input_text",
      description: "Type text into the currently focused input field",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type" },
          targetPid: { type: "number", description: "Desktop only: PID of target process. When provided, sends input without stealing window focus." },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screenshot/get_ui.", default: false },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["text"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const targetPid = args.targetPid as number | undefined;
      await ctx.deviceManager.inputText(args.text as string, platform, targetPid);
      let result = `Entered text: "${args.text}"`;
      if (args.hints === true) {
        result += await ctx.generateActionHints(platform as string | undefined);
      }
      return { text: result };
    },
  },
  {
    tool: {
      name: "input_key",
      description: "Press a key button. Android: BACK, HOME, ENTER, etc. iOS: HOME, VOLUME_UP, VOLUME_DOWN",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name: BACK, HOME, ENTER, TAB, DELETE, MENU, POWER, VOLUME_UP, VOLUME_DOWN, etc." },
          targetPid: { type: "number", description: "Desktop only: PID of target process. When provided, sends key without stealing window focus." },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screenshot/get_ui.", default: false },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["key"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const targetPid = args.targetPid as number | undefined;
      await ctx.deviceManager.pressKey(args.key as string, platform, targetPid);
      let result = `Pressed key: ${args.key}`;
      if (args.hints === true) {
        result += await ctx.generateActionHints(platform as string | undefined);
      }
      return { text: result };
    },
  },
];
