import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { platformEnum, deviceIdField } from "./common-schema.js";
import { ValidationError } from "../errors.js";
import { resolveElementCoordinates, applyScale } from "./helpers/resolve-element.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Tool operation was cancelled.");
  }
}


export const interactionTools: ToolDefinition[] = [
  defineTool({
    name: "input_tap",
    description:
      "Tap by coordinates, text, resourceId, label, or element index.\n\n" +
      "COORDINATE SPACE: raw x/y are interpreted in the **last captured screenshot's pixel space** and " +
      "auto-scaled to device coordinates before dispatch. If no screen(action:'capture') has been called yet, " +
      "the scale defaults to 1× (i.e., x/y are treated as device coords). The resolution from the most recent " +
      "screenshot is used — capturing at preset='low' (270×480) then tapping with x/y from that image works " +
      "transparently. Coordinates returned by ui(action:'find') and ui(action:'tree') are ALREADY target " +
      "coordinates (Android pixels or iOS points); do not pass them as raw screenshot x/y after a capture. " +
      "Prefer label/text/resourceId/index selectors for UI-tree-sourced interactions.",
    schema: z.object({
      x: z.number().optional().describe("X coordinate (screenshot pixel space — see tool description)"),
      y: z.number().optional().describe("Y coordinate (screenshot pixel space — see tool description)"),
      text: z.string().optional().describe("Android/HarmonyOS: Element text. iOS: Element name (less reliable than label)"),
      label: z.string().optional().describe("iOS only: Accessibility label (most reliable)"),
      resourceId: z.string().optional().describe("Find element with this resource ID and tap it (Android/HarmonyOS)"),
      index: z.number().optional().describe("Tap element by index from ui(action:'tree') output (Android/HarmonyOS)"),
      targetPid: z.number().optional().describe("Desktop only: PID of target process. When provided, sends tap without stealing window focus."),
      hints: z.boolean().default(true).describe("Return hints about what changed after the action (new/gone elements, suggestions). Eliminates need for follow-up screen(action:'capture')/ui(action:'tree')."),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      throwIfAborted(ctx.signal);
      const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform;

      const resolved = await resolveElementCoordinates(
        args as Record<string, unknown>,
        ctx,
        currentPlatform,
        deviceId,
      );
      throwIfAborted(ctx.signal);

      if (!resolved) {
        throw new ValidationError("Please provide x,y coordinates, text, resourceId, label, or index.");
      }

      if (resolved.iosTapDone) {
        if (resolved.elementId) {
          throwIfAborted(ctx.signal);
          const iosClient = ctx.deviceManager.getIosClient(deviceId);
          await iosClient.tapElement(resolved.elementId);
          throwIfAborted(ctx.signal);
        }
        throwIfAborted(ctx.signal);
        let result = `Tapped element: ${resolved.description}`;
        if (args.hints) {
          throwIfAborted(ctx.signal);
          result += await ctx.generateActionHints(args.platform, deviceId);
        }
        return textResult(result);
      }

      let { x, y } = resolved;

      if (resolved.fromRawArgs) {
        ({ x, y } = await applyScale(x, y, currentPlatform ?? undefined, ctx, deviceId));
        throwIfAborted(ctx.signal);
      }

      await ctx.deviceManager.tap(x, y, platform, args.targetPid, deviceId, ctx.signal);
      throwIfAborted(ctx.signal);
      ctx.invalidateUiTreeCache(currentPlatform ?? undefined, deviceId);
      let result = `Tapped at (${x}, ${y})`;
      if (args.hints) {
        throwIfAborted(ctx.signal);
        result += await ctx.generateActionHints(args.platform, deviceId);
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
      text: z.string().optional().describe("Find element by text and double tap it (Android/HarmonyOS)"),
      resourceId: z.string().optional().describe("Find element with this resource ID and double tap it (Android/HarmonyOS)"),
      index: z.number().optional().describe("Double tap element by index from ui(action:'tree') output (Android/HarmonyOS)"),
      interval: z.number().default(100).describe("Delay between taps in milliseconds (default: 100)"),
      hints: z.boolean().default(true).describe("Return hints about what changed after the action."),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      throwIfAborted(ctx.signal);
      const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform;
      const interval = args.interval;

      const resolved = await resolveElementCoordinates(
        args as Record<string, unknown>,
        ctx,
        currentPlatform,
        deviceId,
      );
      throwIfAborted(ctx.signal);

      if (!resolved) {
        throw new ValidationError("Please provide x,y coordinates, text, resourceId, or index.");
      }

      if (resolved.iosTapDone) {
        if (!resolved.elementId) {
          throw new ValidationError(
            `Could not double tap element: ${resolved.description}. ` +
              "WebDriverAgent returned no target coordinates or element ID.",
          );
        }

        const iosClient = ctx.deviceManager.getIosClient(deviceId) as unknown as {
          doubleTapElement?: (elementId: string, intervalMs?: number) => void | Promise<void>;
          doubleTapElementById?: (elementId: string, intervalMs?: number) => void | Promise<void>;
        };
        if (typeof iosClient.doubleTapElement === "function") {
          throwIfAborted(ctx.signal);
          await iosClient.doubleTapElement(resolved.elementId, interval);
          throwIfAborted(ctx.signal);
        } else if (typeof iosClient.doubleTapElementById === "function") {
          throwIfAborted(ctx.signal);
          await iosClient.doubleTapElementById(resolved.elementId, interval);
          throwIfAborted(ctx.signal);
        } else {
          throw new ValidationError(
            `Could not double tap element: ${resolved.description}. ` +
              "WebDriverAgent returned no coordinates and does not support target-aware double tap.",
          );
        }

        throwIfAborted(ctx.signal);
        let result = `Double tapped element: ${resolved.description} with ${interval}ms interval`;
        if (args.hints) {
          throwIfAborted(ctx.signal);
          result += await ctx.generateActionHints(args.platform, deviceId);
        }
        return textResult(result);
      }

      let { x, y } = resolved;

      if (resolved.fromRawArgs) {
        ({ x, y } = await applyScale(x, y, currentPlatform ?? undefined, ctx, deviceId));
        throwIfAborted(ctx.signal);
      }

      await ctx.deviceManager.doubleTap(x, y, interval, platform, deviceId, ctx.signal);
      throwIfAborted(ctx.signal);
      let result = `Double tapped at (${x}, ${y}) with ${interval}ms interval`;
      if (args.hints) {
        throwIfAborted(ctx.signal);
        result += await ctx.generateActionHints(args.platform, deviceId);
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
      text: z.string().optional().describe("Find element by text (Android/HarmonyOS)"),
      duration: z.number().default(1000).describe("Duration in milliseconds (default: 1000)"),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      throwIfAborted(ctx.signal);
      const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform;
      const duration = args.duration;

      const resolved = await resolveElementCoordinates(
        args as Record<string, unknown>,
        ctx,
        currentPlatform,
        deviceId,
      );
      throwIfAborted(ctx.signal);

      if (!resolved) {
        throw new ValidationError("Please provide x,y coordinates, text, or label.");
      }

      if (resolved.iosTapDone) {
        if (resolved.elementId) {
          const iosClient = ctx.deviceManager.getIosClient(deviceId);
          const rect = await iosClient.getElementRect(resolved.elementId);
          throwIfAborted(ctx.signal);
          if (rect) {
            const cx = Math.round(rect.x + rect.width / 2);
            const cy = Math.round(rect.y + rect.height / 2);
            throwIfAborted(ctx.signal);
            await ctx.deviceManager.longPress(cx, cy, duration, platform, deviceId, ctx.signal);
            throwIfAborted(ctx.signal);
            return textResult(`Long pressed element: ${resolved.description} at (${cx}, ${cy}) for ${duration}ms`);
          }
        }
        throw new ValidationError(`Could not resolve coordinates for element: ${resolved.description}`);
      }

      let { x, y } = resolved;

      if (resolved.fromRawArgs) {
        ({ x, y } = await applyScale(x, y, currentPlatform ?? undefined, ctx, deviceId));
        throwIfAborted(ctx.signal);
      }

      await ctx.deviceManager.longPress(x, y, duration, platform, deviceId, ctx.signal);
      throwIfAborted(ctx.signal);
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
      throwIfAborted(ctx.signal);
      const { deviceId, platform: currentPlatform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform;
      const direction = args.direction;

      if (direction) {
        await ctx.deviceManager.swipeDirection(direction, platform, deviceId, ctx.signal);
        throwIfAborted(ctx.signal);
        ctx.invalidateUiTreeCache(platform ?? ctx.deviceManager.getCurrentPlatform() ?? undefined, deviceId);
        let result = `Swiped ${direction}`;
        if (args.hints) {
          throwIfAborted(ctx.signal);
          result += await ctx.generateActionHints(args.platform, deviceId);
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
        const p1 = await applyScale(x1, y1, currentPlatform ?? undefined, ctx, deviceId);
        const p2 = await applyScale(x2, y2, currentPlatform ?? undefined, ctx, deviceId);
        throwIfAborted(ctx.signal);
        await ctx.deviceManager.swipe(p1.x, p1.y, p2.x, p2.y, duration, platform, deviceId, ctx.signal);
        throwIfAborted(ctx.signal);
        ctx.invalidateUiTreeCache(currentPlatform ?? undefined, deviceId);
        let result = `Swiped from (${p1.x}, ${p1.y}) to (${p2.x}, ${p2.y})`;
        if (args.hints) {
          throwIfAborted(ctx.signal);
          result += await ctx.generateActionHints(args.platform, deviceId);
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
      throwIfAborted(ctx.signal);
      const { deviceId } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform;
      const text = args.text;
      await ctx.deviceManager.inputText(text, platform, args.targetPid, deviceId, ctx.signal);
      throwIfAborted(ctx.signal);
      ctx.invalidateUiTreeCache(platform ?? ctx.deviceManager.getCurrentPlatform() ?? undefined, deviceId);
      let result = `Entered ${text.length} character(s).`;
      if (args.hints) {
        throwIfAborted(ctx.signal);
        result += await ctx.generateActionHints(args.platform, deviceId);
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
      throwIfAborted(ctx.signal);
      const { deviceId } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform;
      const key = args.key;
      await ctx.deviceManager.pressKey(key, platform, args.targetPid, deviceId, ctx.signal);
      throwIfAborted(ctx.signal);
      ctx.invalidateUiTreeCache(platform ?? ctx.deviceManager.getCurrentPlatform() ?? undefined, deviceId);
      let result = `Pressed key: ${key}`;
      if (args.hints) {
        throwIfAborted(ctx.signal);
        result += await ctx.generateActionHints(args.platform, deviceId);
      }
      return textResult(result);
    },
  }),
];
