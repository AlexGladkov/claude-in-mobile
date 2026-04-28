import type { ToolDefinition } from "./registry.js";
import type { Platform } from "../device-manager.js";
import { ValidationError } from "../errors.js";
import { resolveElementCoordinates, applyScale } from "./helpers/resolve-element.js";
import { getNumber, getString, requireString, getBoolean } from "./helpers/args-parser.js";

export const interactionTools: ToolDefinition[] = [
  {
    tool: {
      name: "input_tap",
      description: "Tap by coordinates, text, resourceId, label, or element index",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate to tap" },
          y: { type: "number", description: "Y coordinate to tap" },
          text: { type: "string", description: "Android: Element text. iOS: Element name (less reliable than label)" },
          label: { type: "string", description: "iOS only: Accessibility label (most reliable)" },
          resourceId: { type: "string", description: "Find element with this resource ID and tap it (Android only)" },
          index: { type: "number", description: "Tap element by index from ui(action:'tree') output (Android only)" },
          targetPid: { type: "number", description: "Desktop only: PID of target process. When provided, sends tap without stealing window focus." },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screen(action:'capture')/ui(action:'tree').", default: true },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      const resolved = await resolveElementCoordinates(args, ctx, currentPlatform);

      if (!resolved) {
        throw new ValidationError("Please provide x,y coordinates, text, resourceId, label, or index.");
      }

      // iOS element-based tap already performed by resolveElementCoordinates
      if (resolved.iosTapDone) {
        return { text: `Tapped element: ${resolved.description}` };
      }

      let { x, y } = resolved;

      // Scale raw screenshot coordinates -> device coordinates
      if (resolved.fromRawArgs) {
        ({ x, y } = applyScale(x, y, currentPlatform ?? undefined, ctx));
      }

      const targetPid = getNumber(args, "targetPid");
      await ctx.deviceManager.tap(x, y, platform, targetPid);
      ctx.invalidateUiTreeCache(currentPlatform ?? undefined);
      let result = `Tapped at (${x}, ${y})`;
      if (getBoolean(args, "hints", true)) {
        result += await ctx.generateActionHints(getString(args, "platform"));
      }
      return { text: result };
    },
  },
  {
    tool: {
      name: "input_double_tap",
      description: "Double tap by coordinates, text, resourceId, or index",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate to tap" },
          y: { type: "number", description: "Y coordinate to tap" },
          text: { type: "string", description: "Find element by text and double tap it (Android only)" },
          resourceId: { type: "string", description: "Find element with this resource ID and double tap it (Android only)" },
          index: { type: "number", description: "Double tap element by index from ui(action:'tree') output (Android only)" },
          interval: { type: "number", description: "Delay between taps in milliseconds (default: 100)", default: 100 },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screen(action:'capture')/ui(action:'tree').", default: true },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const interval = getNumber(args, "interval") ?? 100;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      const resolved = await resolveElementCoordinates(args, ctx, currentPlatform);

      if (!resolved) {
        throw new ValidationError("Please provide x,y coordinates, text, resourceId, or index.");
      }

      let { x, y } = resolved;

      if (resolved.fromRawArgs) {
        ({ x, y } = applyScale(x, y, currentPlatform ?? undefined, ctx));
      }

      await ctx.deviceManager.doubleTap(x, y, interval, platform);
      let result = `Double tapped at (${x}, ${y}) with ${interval}ms interval`;
      if (getBoolean(args, "hints", true)) {
        result += await ctx.generateActionHints(getString(args, "platform"));
      }
      return { text: result };
    },
  },
  {
    tool: {
      name: "input_long_press",
      description: "Long press at coordinates or on element by text",
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
      const duration = getNumber(args, "duration") ?? 1000;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      const resolved = await resolveElementCoordinates(args, ctx, currentPlatform);

      if (!resolved) {
        throw new ValidationError("Please provide x,y coordinates or text.");
      }

      let { x, y } = resolved;

      if (resolved.fromRawArgs) {
        ({ x, y } = applyScale(x, y, currentPlatform ?? undefined, ctx));
      }

      await ctx.deviceManager.longPress(x, y, duration, platform);
      return { text: `Long pressed at (${x}, ${y}) for ${duration}ms` };
    },
  },
  {
    tool: {
      name: "input_swipe",
      description: "Swipe by direction or custom coordinates",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Swipe direction" },
          x1: { type: "number", description: "Start X (for custom swipe)" },
          y1: { type: "number", description: "Start Y (for custom swipe)" },
          x2: { type: "number", description: "End X (for custom swipe)" },
          y2: { type: "number", description: "End Y (for custom swipe)" },
          duration: { type: "number", description: "Duration in ms (default: 300)", default: 300 },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screen(action:'capture')/ui(action:'tree').", default: true },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const direction = getString(args, "direction") as "up" | "down" | "left" | "right" | undefined;

      if (direction) {
        await ctx.deviceManager.swipeDirection(direction, platform);
        ctx.invalidateUiTreeCache(platform ?? ctx.deviceManager.getCurrentPlatform() ?? undefined);
        let result = `Swiped ${direction}`;
        if (getBoolean(args, "hints", true)) {
          result += await ctx.generateActionHints(getString(args, "platform"));
        }
        return { text: result };
      }

      const x1 = getNumber(args, "x1");
      const y1 = getNumber(args, "y1");
      const x2 = getNumber(args, "x2");
      const y2 = getNumber(args, "y2");

      if (x1 !== undefined && y1 !== undefined &&
          x2 !== undefined && y2 !== undefined) {
        const duration = getNumber(args, "duration") ?? 300;
        const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();
        const p1 = applyScale(x1, y1, currentPlatform ?? undefined, ctx);
        const p2 = applyScale(x2, y2, currentPlatform ?? undefined, ctx);
        await ctx.deviceManager.swipe(p1.x, p1.y, p2.x, p2.y, duration, platform);
        ctx.invalidateUiTreeCache(currentPlatform ?? undefined);
        let result = `Swiped from (${p1.x}, ${p1.y}) to (${p2.x}, ${p2.y})`;
        if (getBoolean(args, "hints", true)) {
          result += await ctx.generateActionHints(getString(args, "platform"));
        }
        return { text: result };
      }

      throw new ValidationError("Please provide direction or x1,y1,x2,y2 coordinates.");
    },
  },
  {
    tool: {
      name: "input_text",
      description: "Type text into focused input field",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type" },
          targetPid: { type: "number", description: "Desktop only: PID of target process. When provided, sends input without stealing window focus." },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screen(action:'capture')/ui(action:'tree').", default: true },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["text"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const targetPid = getNumber(args, "targetPid");
      const text = requireString(args, "text");
      await ctx.deviceManager.inputText(text, platform, targetPid);
      ctx.invalidateUiTreeCache(platform ?? ctx.deviceManager.getCurrentPlatform() ?? undefined);
      let result = `Entered text: "${text}"`;
      if (getBoolean(args, "hints", true)) {
        result += await ctx.generateActionHints(getString(args, "platform"));
      }
      return { text: result };
    },
  },
  {
    tool: {
      name: "input_key",
      description: "Press hardware key (BACK, HOME, ENTER, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name: BACK, HOME, ENTER, TAB, DELETE, MENU, POWER, VOLUME_UP, VOLUME_DOWN, etc." },
          targetPid: { type: "number", description: "Desktop only: PID of target process. When provided, sends key without stealing window focus." },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screen(action:'capture')/ui(action:'tree').", default: true },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["key"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const targetPid = getNumber(args, "targetPid");
      const key = requireString(args, "key");
      await ctx.deviceManager.pressKey(key, platform, targetPid);
      ctx.invalidateUiTreeCache(platform ?? ctx.deviceManager.getCurrentPlatform() ?? undefined);
      let result = `Pressed key: ${key}`;
      if (getBoolean(args, "hints", true)) {
        result += await ctx.generateActionHints(getString(args, "platform"));
      }
      return { text: result };
    },
  },
];
