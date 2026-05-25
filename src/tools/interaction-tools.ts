import type { ToolDefinition } from "./registry.js";
import type { Platform } from "../device-manager.js";
import { ValidationError } from "../errors.js";
import { resolveElementCoordinates, applyScale } from "./helpers/resolve-element.js";
import { getNumber, getString, requireString, getBoolean } from "./helpers/args-parser.js";

export const interactionTools: ToolDefinition[] = [
  {
    tool: {
      name: "input_tap",
      description:
        "Tap by coordinates, text, resourceId, label, or element index.\n\n" +
        "COORDINATE SPACE: raw x/y are interpreted in the **last captured screenshot's pixel space** and " +
        "auto-scaled to device coordinates before dispatch. If no screen(action:'capture') has been called yet, " +
        "the scale defaults to 1× (i.e., x/y are treated as device coords). The resolution from the most recent " +
        "screenshot is used — capturing at preset='low' (270×480) then tapping with x/y from that image works " +
        "transparently. Coordinates returned by ui(action:'find') and ui(action:'tree') are ALREADY device " +
        "coordinates from uiautomator; passing them as raw x/y when a low-res screenshot is the most recent " +
        "capture will OVER-SCALE them. Prefer index/text/resourceId for ui_*-sourced taps to avoid this pitfall.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate (screenshot pixel space — see tool description)" },
          y: { type: "number", description: "Y coordinate (screenshot pixel space — see tool description)" },
          text: { type: "string", description: "Android: Element text. iOS: Element name (less reliable than label)" },
          label: { type: "string", description: "iOS only: Accessibility label (most reliable)" },
          resourceId: { type: "string", description: "Find element with this resource ID and tap it (Android only)" },
          index: { type: "number", description: "Tap element by index from ui(action:'tree') output (Android only)" },
          targetPid: { type: "number", description: "Desktop only: PID of target process. When provided, sends tap without stealing window focus." },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screen(action:'capture')/ui(action:'tree').", default: true },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const deviceId = args.deviceId as string | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      const resolved = await resolveElementCoordinates(args, ctx, currentPlatform);

      if (!resolved) {
        throw new ValidationError("Please provide x,y coordinates, text, resourceId, label, or index.");
      }

      // iOS element-based resolution — tap via element ID when rect was unavailable
      if (resolved.iosTapDone) {
        if (resolved.elementId) {
          const iosClient = ctx.deviceManager.getIosClient();
          await iosClient.tapElement(resolved.elementId);
        }
        let result = `Tapped element: ${resolved.description}`;
        if (getBoolean(args, "hints", true)) {
          result += await ctx.generateActionHints(getString(args, "platform"));
        }
        return { text: result };
      }

      let { x, y } = resolved;

      // Scale raw screenshot coordinates -> device coordinates
      if (resolved.fromRawArgs) {
        ({ x, y } = applyScale(x, y, currentPlatform ?? undefined, ctx));
      }

      const targetPid = getNumber(args, "targetPid");
      await ctx.deviceManager.tap(x, y, platform, targetPid, deviceId);
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
      description: "Double tap by coordinates, text, resourceId, or index. Raw x/y are screenshot-space and auto-scaled to device coordinates — see input_tap description for full coordinate space rules.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate (screenshot pixel space)" },
          y: { type: "number", description: "Y coordinate (screenshot pixel space)" },
          text: { type: "string", description: "Find element by text and double tap it (Android only)" },
          resourceId: { type: "string", description: "Find element with this resource ID and double tap it (Android only)" },
          index: { type: "number", description: "Double tap element by index from ui(action:'tree') output (Android only)" },
          interval: { type: "number", description: "Delay between taps in milliseconds (default: 100)", default: 100 },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screen(action:'capture')/ui(action:'tree').", default: true },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const deviceId = args.deviceId as string | undefined;
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

      await ctx.deviceManager.doubleTap(x, y, interval, platform, deviceId);
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
      description: "Long press at coordinates or on element by text/label. Raw x/y are screenshot-space and auto-scaled to device coordinates — see input_tap description for full coordinate space rules.",
      inputSchema: {
        type: "object",
        properties: {
          x: { type: "number", description: "X coordinate (screenshot pixel space)" },
          y: { type: "number", description: "Y coordinate (screenshot pixel space)" },
          label: { type: "string", description: "iOS only: Accessibility label (most reliable)" },
          text: { type: "string", description: "Find element by text (Android only)" },
          duration: { type: "number", description: "Duration in milliseconds (default: 1000)", default: 1000 },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const deviceId = args.deviceId as string | undefined;
      const duration = getNumber(args, "duration") ?? 1000;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      const resolved = await resolveElementCoordinates(args, ctx, currentPlatform);

      if (!resolved) {
        throw new ValidationError("Please provide x,y coordinates, text, or label.");
      }

      // iOS element-based long press via WDA actions on element coordinates
      if (resolved.iosTapDone) {
        if (resolved.elementId) {
          // Use element center via WDA long press at (0,0) won't work — re-fetch rect or use coordinate-based approach
          // Since element was found but rect failed, perform long press via WDA actions at element
          const iosClient = ctx.deviceManager.getIosClient();
          // Try getting rect one more time directly through WDA
          const rect = await iosClient.getElementRect(resolved.elementId);
          if (rect) {
            const cx = Math.round(rect.x + rect.width / 2);
            const cy = Math.round(rect.y + rect.height / 2);
            await ctx.deviceManager.longPress(cx, cy, duration, platform, deviceId);
            return { text: `Long pressed element: ${resolved.description} at (${cx}, ${cy}) for ${duration}ms` };
          }
        }
        throw new ValidationError(`Could not resolve coordinates for element: ${resolved.description}`);
      }

      let { x, y } = resolved;

      if (resolved.fromRawArgs) {
        ({ x, y } = applyScale(x, y, currentPlatform ?? undefined, ctx));
      }

      await ctx.deviceManager.longPress(x, y, duration, platform, deviceId);
      return { text: `Long pressed at (${x}, ${y}) for ${duration}ms` };
    },
  },
  {
    tool: {
      name: "input_swipe",
      description: "Swipe by direction or custom coordinates. Raw x1/y1/x2/y2 are screenshot-space and auto-scaled to device coordinates — see input_tap description for full coordinate space rules.",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Swipe direction" },
          x1: { type: "number", description: "Start X (screenshot pixel space)" },
          y1: { type: "number", description: "Start Y (screenshot pixel space)" },
          x2: { type: "number", description: "End X (screenshot pixel space)" },
          y2: { type: "number", description: "End Y (screenshot pixel space)" },
          duration: { type: "number", description: "Duration in ms (default: 300)", default: 300 },
          hints: { type: "boolean", description: "Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screen(action:'capture')/ui(action:'tree').", default: true },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const deviceId = args.deviceId as string | undefined;
      const direction = getString(args, "direction") as "up" | "down" | "left" | "right" | undefined;

      if (direction) {
        await ctx.deviceManager.swipeDirection(direction, platform, deviceId);
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
        await ctx.deviceManager.swipe(p1.x, p1.y, p2.x, p2.y, duration, platform, deviceId);
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
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["text"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const deviceId = args.deviceId as string | undefined;
      const targetPid = getNumber(args, "targetPid");
      const text = requireString(args, "text");
      await ctx.deviceManager.inputText(text, platform, targetPid, deviceId);
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
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["key"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const deviceId = args.deviceId as string | undefined;
      const targetPid = getNumber(args, "targetPid");
      const key = requireString(args, "key");
      await ctx.deviceManager.pressKey(key, platform, targetPid, deviceId);
      ctx.invalidateUiTreeCache(platform ?? ctx.deviceManager.getCurrentPlatform() ?? undefined);
      let result = `Pressed key: ${key}`;
      if (getBoolean(args, "hints", true)) {
        result += await ctx.generateActionHints(getString(args, "platform"));
      }
      return { text: result };
    },
  },
];
