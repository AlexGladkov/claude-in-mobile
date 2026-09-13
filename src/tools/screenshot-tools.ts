import type { ToolDefinition } from "./registry.js";
import type { Platform } from "../device-manager.js";
import { defineTool, z } from "./define-tool.js";
import { platformEnum, deviceIdField } from "./common-schema.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";
import type { ToolResult } from "../utils/tool-result.js";
import { sleep } from "../utils/sleep.js";
import { SCREEN } from "../constants/timeouts.js";
import {
  annotateScreenshot,
  compareScreenshots,
  cropRegion,
  compressScreenshot,
} from "../utils/image.js";
import { parseUiHierarchy, UiElement } from "../ui-tree/ui-parser.js";
import { getUiElements } from "./helpers/get-elements.js";
import { screenshotStateKey } from "./context/shared-state-class.js";

const STABLE_THRESHOLD_PERCENT = 2;

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (
    buffer.length < 24
    || buffer.readUInt32BE(0) !== 0x89504e47
    || buffer.readUInt32BE(4) !== 0x0d0a1a0a
  ) {
    throw new Error("Screenshot provider returned invalid PNG data");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Quality presets shared by the capture handler and the JSON-schema facade.
 * `medium` doubles as the default fallback applied LAST in the handler once
 * the params are optional (no zod default) — see #56.
 */
export const SCREEN_PRESETS = {
  low: { maxWidth: 270, maxHeight: 480, quality: 40 },
  medium: { maxWidth: 540, maxHeight: 960, quality: 55 },
  high: { maxWidth: 810, maxHeight: 1440, quality: 70 },
} as const;

/** Hard bounds advertised in the param descriptions — clamp to prevent DoS. */
const DIMENSION_MAX = 2000;
const QUALITY_MIN = 1;
const QUALITY_MAX = 100;

async function waitForStableScreenshot(getBuffer: () => Promise<Buffer>): Promise<Buffer> {
  let prev = await getBuffer();
  for (let i = 0; i < SCREEN.STABLE_MAX_RETRIES; i++) {
    await sleep(SCREEN.STABLE_INTERVAL_MS);
    const next = await getBuffer();
    const diff = await compareScreenshots(prev, next, 30);
    if (diff.changePercent < STABLE_THRESHOLD_PERCENT) {
      return next;
    }
    prev = next;
  }
  return prev; // Return last capture even if not fully stable
}

export const screenshotTools: ToolDefinition[] = [
  defineTool({
    name: "screen_capture",
    description: "Take screenshot. Auto-compressed. Use diff=true to see only changes.",
    schema: z.object({
      platform: platformEnum,
      compress: z
        .boolean()
        .default(true)
        .describe("Compress image (default: true). Set false for original quality."),
      // Optional (NOT .default) so an unset value stays undefined and lets
      // `preset` win; the medium default is applied last in the handler.
      // A zod .default() here made these args never-undefined, so the
      // `args.X ?? preset` resolution always took the default and the preset
      // was silently ignored (#56). .min/.max clamp advertised bounds so an
      // out-of-range value cannot drive an unbounded sharp.resize (DoS).
      maxWidth: z
        .number()
        .min(1)
        .max(DIMENSION_MAX)
        .optional()
        .describe(
          "Max width in pixels (overrides preset; default via preset or 540). Lower values reduce token cost. Max 2000 for API.",
        ),
      maxHeight: z
        .number()
        .min(1)
        .max(DIMENSION_MAX)
        .optional()
        .describe(
          "Max height in pixels (overrides preset; default via preset or 960). Lower values reduce token cost. Max 2000 for API.",
        ),
      quality: z
        .number()
        .min(QUALITY_MIN)
        .max(QUALITY_MAX)
        .optional()
        .describe(
          "JPEG quality 1-100 (overrides preset; default via preset or 55). Lower = smaller size, faster processing.",
        ),
      monitorIndex: z
        .number()
        .optional()
        .describe(
          "Monitor index for multi-monitor desktop setups (Desktop only). If not specified, captures all monitors.",
        ),
      diff: z
        .boolean()
        .default(false)
        .describe(
          "Compare with previous screenshot. Returns only changed region (<5% change = text only, 5-80% = cropped diff, >80% = full screenshot).",
        ),
      diffThreshold: z
        .number()
        .default(30)
        .describe(
          "Pixel difference threshold 0-255 for diff mode (default: 30). Lower = more sensitive.",
        ),
      waitForStable: z
        .boolean()
        .default(false)
        .describe(
          "Wait for UI to stabilize before capturing. Takes two captures ~300ms apart and compares them; retries up to 3 times until change < 2%. Useful after navigation or animations.",
        ),
      preset: z.string().optional(),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform as Platform | undefined;
      const compress = args.compress !== false;
      const diffMode = args.diff === true;
      const stableMode = args.waitForStable === true;
      const diffThreshold = args.diffThreshold;

      // Precedence: explicit param → preset → medium default. Because the
      // params are now optional (no zod default), an unset value is undefined
      // and preset actually takes effect. The medium default is applied LAST
      // here (not as a zod default) so a no-preset + no-explicit call still
      // gets concrete dimensions instead of undefined (#56).
      const preset = args.preset
        ? SCREEN_PRESETS[args.preset as keyof typeof SCREEN_PRESETS]
        : undefined;
      const compressOptions = {
        maxWidth: args.maxWidth ?? preset?.maxWidth ?? SCREEN_PRESETS.medium.maxWidth,
        maxHeight: args.maxHeight ?? preset?.maxHeight ?? SCREEN_PRESETS.medium.maxHeight,
        quality: args.quality ?? preset?.quality ?? SCREEN_PRESETS.medium.quality,
        monitorIndex: args.monitorIndex,
        turbo: ctx.turboDefault,
      };
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";
      const stateKey = screenshotStateKey(currentPlatform, deviceId);
      // A diff/cropped result has no stable full-screen coordinate transform.
      // Clear any prior transform before capturing so it cannot be reused.
      ctx.screenshotScaleMap.delete(stateKey);

      const captureBuffer = () =>
        ctx.deviceManager.getScreenshotBufferAsync(currentPlatform, deviceId);

      if (diffMode) {
        const pngBuffer = stableMode
          ? await waitForStableScreenshot(captureBuffer)
          : await captureBuffer();
        const prevBuffer = ctx.lastScreenshotMap.get(stateKey);
        ctx.lastScreenshotMap.set(stateKey, pngBuffer);

        if (!prevBuffer) {
          const result = compress
            ? await compressScreenshot(pngBuffer, compressOptions)
            : { data: pngBuffer.toString("base64"), mimeType: "image/png" };
          return {
            image: { data: result.data, mimeType: result.mimeType },
            text: "First screenshot (no previous to diff against)",
          } as unknown as ToolResult;
        }

        const diff = await compareScreenshots(prevBuffer, pngBuffer, diffThreshold);

        if (diff.changePercent < 5) {
          return textResult(`Screen unchanged (${diff.changePercent}% diff)`);
        }

        if (diff.changePercent >= 80 || !diff.changedRegion) {
          const result = compress
            ? await compressScreenshot(pngBuffer, compressOptions)
            : { data: pngBuffer.toString("base64"), mimeType: "image/png" };
          return {
            image: { data: result.data, mimeType: result.mimeType },
            text: `Screen changed significantly (${diff.changePercent}% diff) — full screenshot`,
          } as unknown as ToolResult;
        }

        const croppedBuffer = await cropRegion(pngBuffer, diff.changedRegion, 20);
        const result = compress
          ? await compressScreenshot(croppedBuffer, compressOptions)
          : { data: croppedBuffer.toString("base64"), mimeType: "image/png" };
        return {
          image: { data: result.data, mimeType: result.mimeType },
          text: `Changed region (${diff.changePercent}% diff) at (${diff.changedRegion.x}, ${diff.changedRegion.y}) ${diff.changedRegion.width}x${diff.changedRegion.height}`,
        } as unknown as ToolResult;
      }

      // Standard screenshot (non-diff) — single capture, reuse buffer
      const pngBuffer = stableMode
        ? await waitForStableScreenshot(captureBuffer)
        : await captureBuffer();
      ctx.lastScreenshotMap.set(stateKey, pngBuffer);

      if (!compress) {
        const dimensions = readPngDimensions(pngBuffer);
        ctx.screenshotScaleMap.set(stateKey, {
          scaleX: 1,
          scaleY: 1,
          originalWidth: dimensions.width,
          originalHeight: dimensions.height,
        });
        return {
          image: { data: pngBuffer.toString("base64"), mimeType: "image/png" },
        } as unknown as ToolResult;
      }

      const result = await compressScreenshot(pngBuffer, compressOptions);
      const scaleX = result.originalWidth / result.width;
      const scaleY = result.originalHeight / result.height;
      const scaled = scaleX !== 1 || scaleY !== 1;

      // Store scale so interaction tools can auto-correct coordinates
      ctx.screenshotScaleMap.set(stateKey, {
        scaleX, scaleY,
        originalWidth: result.originalWidth,
        originalHeight: result.originalHeight,
      });

      return {
        image: { data: result.data, mimeType: result.mimeType },
        text: scaled
          ? `Screenshot: ${result.width}x${result.height} (device: ${result.originalWidth}x${result.originalHeight}). Coordinate scaling applied automatically.`
          : undefined,
      } as unknown as ToolResult;
    },
  }),

  defineTool({
    name: "screen_annotate",
    description: "Screenshot with numbered bounding boxes on UI elements (Android/iOS)",
    schema: z.object({
      platform: platformEnum,
      maxWidth: z
        .number()
        .min(1)
        .max(DIMENSION_MAX)
        .default(SCREEN_PRESETS.medium.maxWidth)
        .describe(
          "Max width in pixels (default: 540). Lower values reduce token cost. Max 2000 for API.",
        ),
      maxHeight: z
        .number()
        .min(1)
        .max(DIMENSION_MAX)
        .default(SCREEN_PRESETS.medium.maxHeight)
        .describe(
          "Max height in pixels (default: 960). Lower values reduce token cost. Max 2000 for API.",
        ),
      quality: z
        .number()
        .min(QUALITY_MIN)
        .max(QUALITY_MAX)
        .default(SCREEN_PRESETS.medium.quality)
        .describe(
          "JPEG quality 1-100 (default: 55). Lower = smaller size, faster processing.",
        ),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform as Platform | undefined;
      const currentPlat = platform ?? ctx.deviceManager.getCurrentPlatform();
      if (currentPlat === "desktop" || currentPlat === "aurora") {
        return textResult(
          `screen(action:'annotate') is not supported for ${currentPlat} platform. Use screen(action:'capture') + ui(action:'tree') instead.`,
        );
      }

      const pngBuffer = await ctx.deviceManager.getScreenshotBufferAsync(currentPlat, deviceId);

      let uiElements: UiElement[] = [];
      try {
        uiElements = (await getUiElements(ctx, currentPlat, deviceId)).elements;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[annotate_screenshot] ${currentPlat ?? "android"} UI hierarchy unavailable: ${message}`,
        );
      }

      if (uiElements.length === 0) {
        const result = await compressScreenshot(pngBuffer, {
          maxWidth: args.maxWidth,
          maxHeight: args.maxHeight,
          quality: args.quality,
        });
        return {
          image: { data: result.data, mimeType: result.mimeType },
          text: "No UI elements found to annotate. Returning plain screenshot.",
        } as unknown as ToolResult;
      }

      const annotResult = await annotateScreenshot(pngBuffer, uiElements, {
        maxWidth: args.maxWidth,
        maxHeight: args.maxHeight,
        quality: args.quality,
        turbo: ctx.turboDefault,
      });

      const maxAnnotElements = 100;
      const totalAnnotElements = annotResult.elements.length;
      const displayElements = annotResult.elements.slice(0, maxAnnotElements);
      const elementsList = displayElements
        .map(
          (el) =>
            `  ${el.index}: ${el.clickable ? "[clickable] " : ""}${el.label} @ (${el.center.x}, ${el.center.y})`,
        )
        .join("\n");

      const truncNotice =
        totalAnnotElements > maxAnnotElements
          ? `\n(showing ${maxAnnotElements} of ${totalAnnotElements} elements)`
          : "";

      return {
        image: {
          data: annotResult.image.data,
          mimeType: annotResult.image.mimeType,
        },
        text: `Annotated ${totalAnnotElements} elements:\n${elementsList}${truncNotice}`,
      } as unknown as ToolResult;
    },
  }),
];
