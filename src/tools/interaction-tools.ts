import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { ValidationError } from "../errors.js";
import { resolveElementCoordinates, applyScale } from "./helpers/resolve-element.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";

const platformEnum = z
  .enum(["android", "ios", "desktop", "aurora", "browser"])
  .describe("Target platform. If not specified, uses the active target.")
  .optional();

const deviceIdField = z
  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();

export const interactionTools: ToolDefinition[] = [
  defineTool({
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
    schema: z.object({
      x: z.number().optional().describe("X coordinate (screenshot pixel space — see tool description)"),
      y: z.number().optional().describe("Y coordinate (screenshot pixel space — see tool description)"),
      text: z.string().optional().describe("Android: Element text. iOS: Element name (less reliable than label)"),
      label: z.string().optional().describe("iOS only: Accessibility label (most reliable)"),
      resourceId: z.string().optional().describe("Find element with this resource ID and tap it (Android only)"),
      index: z.number().optional().describe("Tap element by index from ui(action:'tree') output (Android only)"),
      targetPid: z.number().optional().describe("Desktop only: PID of target process. When provided, sends tap without stealing window focus."),
      hints: z.boolean().default(true).describe("Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screen(action:'capture')/ui(action:'tree')."),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform;

      const resolved = await resolveElementCoordinates(
        args as Record<string, unknown>,
        ctx,
        currentPlatform,
        deviceId,
      );

      if (!resolved) {
        throw new ValidationError("Please provide x,y coordinates, text, resourceId, label, or index.");
      }

      if (resolved.iosTapDone) {
        if (resolved.elementId) {
          const iosClient = ctx.deviceManager.getIosClient(deviceId);
          await iosClient.tapElement(resolved.elementId);
        }
        let result = `Tapped element: ${resolved.description}`;
        if (args.hints) {
          result += await ctx.generateActionHints(args.platform);
        }
        return textResult(result);
      }

      let { x, y } = resolved;

      if (resolved.fromRawArgs) {
        ({ x, y } = applyScale(x, y, currentPlatform ?? undefined, ctx));
      }

      await ctx.deviceManager.tap(x, y, platform, args.targetPid, deviceId);
      ctx.invalidateUiTreeCache(currentPlatform ?? undefined);
      let result = `Tapped at (${x}, ${y})`;
      if (args.hints) {
        result += await ctx.generateActionHints(args.platform);
      }
      return textResult(result);
    },
  }),

  defineTool({
    name: "input_double_tap",
    description:
      "Double tap by coordinates, text, resourceId, or index. Raw x/y are screenshot-space and auto-scaled to device coordinates — see input_tap description for full coordinate space rules.",
    schema: z.object({
      x: z.number().optional().describe("X coordinate (screenshot pixel space)"),
      y: z.number().optional().describe("Y coordinate (screenshot pixel space)"),
      text: z.string().optional().describe("Find element by text and double tap it (Android only)"),
      resourceId: z.string().optional().describe("Find element with this resource ID and double tap it (Android only)"),
      index: z.number().optional().describe("Double tap element by index from ui(action:'tree') output (Android only)"),
      interval: z.number().default(100).describe("Delay between taps in milliseconds (default: 100)"),
      hints: z.boolean().default(true).describe("Return hints about what changed after the action."),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform;
      const interval = args.interval;

      const resolved = await resolveElementCoordinates(
        args as Record<string, unknown>,
        ctx,
        currentPlatform,
        deviceId,
      );

      if (!resolved) {
        throw new ValidationError("Please provide x,y coordinates, text, resourceId, or index.");
      }

      let { x, y } = resolved;

      if (resolved.fromRawArgs) {
        ({ x, y } = applyScale(x, y, currentPlatform ?? undefined, ctx));
      }

      await ctx.deviceManager.doubleTap(x, y, interval, platform, deviceId);
      let result = `Double tapped at (${x}, ${y}) with ${interval}ms interval`;
      if (args.hints) {
        result += await ctx.generateActionHints(args.platform);
      }
      return textResult(result);
    },
  }),

  defineTool({
    name: "input_long_press",
    description:
      "Long press at coordinates or on element by text/label. Raw x/y are screenshot-space and auto-scaled to device coordinates — see input_tap description for full coordinate space rules.",
    schema: z.object({
      x: z.number().optional().describe("X coordinate (screenshot pixel space)"),
      y: z.number().optional().describe("Y coordinate (screenshot pixel space)"),
      label: z.string().optional().describe("iOS only: Accessibility label (most reliable)"),
      text: z.string().optional().describe("Find element by text (Android only)"),
      duration: z.number().default(1000).describe("Duration in milliseconds (default: 1000)"),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform;
      const duration = args.duration;

      const resolved = await resolveElementCoordinates(
        args as Record<string, unknown>,
        ctx,
        currentPlatform,
        deviceId,
      );

      if (!resolved) {
        throw new ValidationError("Please provide x,y coordinates, text, or label.");
      }

      if (resolved.iosTapDone) {
        if (resolved.elementId) {
          const iosClient = ctx.deviceManager.getIosClient(deviceId);
          const rect = await iosClient.getElementRect(resolved.elementId);
          if (rect) {
            const cx = Math.round(rect.x + rect.width / 2);
            const cy = Math.round(rect.y + rect.height / 2);
            await ctx.deviceManager.longPress(cx, cy, duration, platform, deviceId);
            return textResult(`Long pressed element: ${resolved.description} at (${cx}, ${cy}) for ${duration}ms`);
          }
        }
        throw new ValidationError(`Could not resolve coordinates for element: ${resolved.description}`);
      }

      let { x, y } = resolved;

      if (resolved.fromRawArgs) {
        ({ x, y } = applyScale(x, y, currentPlatform ?? undefined, ctx));
      }

      await ctx.deviceManager.longPress(x, y, duration, platform, deviceId);
      return textResult(`Long pressed at (${x}, ${y}) for ${duration}ms`);
    },
  }),

  defineTool({
    name: "input_swipe",
    description:
      "Swipe by direction or custom coordinates. Raw x1/y1/x2/y2 are screenshot-space and auto-scaled to device coordinates — see input_tap description for full coordinate space rules.",
    schema: z.object({
      direction: z
        .enum(["up", "down", "left", "right"])
        .optional()
        .describe("Swipe direction"),
      x1: z.number().optional().describe("Start X (screenshot pixel space)"),
      y1: z.number().optional().describe("Start Y (screenshot pixel space)"),
      x2: z.number().optional().describe("End X (screenshot pixel space)"),
      y2: z.number().optional().describe("End Y (screenshot pixel space)"),
      duration: z.number().default(300).describe("Duration in ms (default: 300)"),
      hints: z.boolean().default(true).describe("Return hints about what changed after the action."),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform;
      const direction = args.direction;

      if (direction) {
        await ctx.deviceManager.swipeDirection(direction, platform, deviceId);
        ctx.invalidateUiTreeCache(platform ?? ctx.deviceManager.getCurrentPlatform() ?? undefined);
        let result = `Swiped ${direction}`;
        if (args.hints) {
          result += await ctx.generateActionHints(args.platform);
        }
        return textResult(result);
      }

      const x1 = args.x1;
      const y1 = args.y1;
      const x2 = args.x2;
      const y2 = args.y2;

      if (x1 !== undefined && y1 !== undefined &&
          x2 !== undefined && y2 !== undefined) {
        const duration = args.duration;
        const p1 = applyScale(x1, y1, currentPlatform ?? undefined, ctx);
        const p2 = applyScale(x2, y2, currentPlatform ?? undefined, ctx);
        await ctx.deviceManager.swipe(p1.x, p1.y, p2.x, p2.y, duration, platform, deviceId);
        ctx.invalidateUiTreeCache(currentPlatform ?? undefined);
        let result = `Swiped from (${p1.x}, ${p1.y}) to (${p2.x}, ${p2.y})`;
        if (args.hints) {
          result += await ctx.generateActionHints(args.platform);
        }
        return textResult(result);
      }

      throw new ValidationError("Please provide direction or x1,y1,x2,y2 coordinates.");
    },
  }),

  defineTool({
    name: "input_text",
    description: "Type text into focused input field",
    schema: z.object({
      text: z.string().describe("Text to type"),
      targetPid: z.number().optional().describe("Desktop only: PID of target process. When provided, sends input without stealing window focus."),
      hints: z.boolean().default(true).describe("Return hints about what changed after the action."),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform;
      const text = args.text;
      await ctx.deviceManager.inputText(text, platform, args.targetPid, deviceId);
      ctx.invalidateUiTreeCache(platform ?? ctx.deviceManager.getCurrentPlatform() ?? undefined);
      let result = `Entered text: "${text}"`;
      if (args.hints) {
        result += await ctx.generateActionHints(args.platform);
      }
      return textResult(result);
    },
  }),

  defineTool({
    name: "input_key",
    description: "Press hardware key (BACK, HOME, ENTER, etc.)",
    schema: z.object({
      key: z.string().describe("Key name: BACK, HOME, ENTER, TAB, DELETE, MENU, POWER, VOLUME_UP, VOLUME_DOWN, etc."),
      targetPid: z.number().optional().describe("Desktop only: PID of target process. When provided, sends key without stealing window focus."),
      hints: z.boolean().default(true).describe("Return hints about what changed after the action."),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform;
      const key = args.key;
      await ctx.deviceManager.pressKey(key, platform, args.targetPid, deviceId);
      ctx.invalidateUiTreeCache(platform ?? ctx.deviceManager.getCurrentPlatform() ?? undefined);
      let result = `Pressed key: ${key}`;
      if (args.hints) {
        result += await ctx.generateActionHints(args.platform);
      }
      return textResult(result);
    },
  }),
];
