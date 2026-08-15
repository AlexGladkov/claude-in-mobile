import type { ToolDefinition } from "./registry.js";
import type { Platform } from "../device-manager.js";
import { defineTool, z } from "./define-tool.js";
import { platformEnum, deviceIdField } from "./common-schema.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult, type ToolResult } from "../utils/tool-result.js";
import { sleep } from "../utils/sleep.js";
import { SCREEN } from "../constants/timeouts.js";
import {
  annotateScreenshot,
  compareScreenshots,
  cropRegion,
  compressScreenshot,
  detectUniformFrame,
} from "../utils/image.js";
import { parseUiHierarchy, UiElement } from "../adb/ui-parser.js";
import { hasSecureWindowCheck } from "../adapters/platform-adapter.js";
import type { ToolContext } from "./context.js";

const STABLE_THRESHOLD_PERCENT = 2;

const SCREEN_PRESETS: Record<string, { maxWidth: number; maxHeight: number; quality: number }> = {
  low: { maxWidth: 270, maxHeight: 480, quality: 40 },
  medium: { maxWidth: 540, maxHeight: 960, quality: 55 },
  high: { maxWidth: 810, maxHeight: 1440, quality: 70 },
};

interface BlankFrameAdvisory {
  /** When set, capture is a confirmed secure/black frame — return this instead of the image. */
  earlyReturn?: ToolResult;
  /** A heads-up to prepend to an otherwise-normal result. */
  note?: string;
}

/**
 * A uniform/black screenshot is usually a FLAG_SECURE window (banking/auth/DRM),
 * a blank screen, or a GPU/emulator glitch — the OS enforces the black frame at
 * the screencap level, so retrying is wasted tokens. Detect it and steer the
 * caller to ui(action:'tree'), which Android exempts from FLAG_SECURE.
 */
async function assessBlankFrame(
  pngBuffer: Buffer,
  platform: Platform,
  deviceId: string | undefined,
  ctx: ToolContext,
  bypass: boolean,
): Promise<BlankFrameAdvisory | null> {
  if (bypass) return null;
  let frame;
  try {
    frame = await detectUniformFrame(pngBuffer);
  } catch {
    return null; // detection is best-effort, never blocks a capture
  }
  if (!frame.uniform) return null;

  if (platform === "android") {
    let secure = false;
    try {
      const adapter = ctx.deviceManager.getAdapter("android", deviceId);
      if (hasSecureWindowCheck(adapter)) secure = adapter.isCurrentWindowSecure(deviceId);
    } catch {
      /* best-effort; fall through to the softer advisory */
    }
    if (secure) {
      return {
        earlyReturn: textResult(
          "Screenshot is blank because the focused window has FLAG_SECURE — the OS returns an all-black frame for screencap by design (common in banking / auth / DRM apps). " +
            "The accessibility tree is NOT affected by FLAG_SECURE: call ui(action:'tree') to read the screen content. " +
            "Pass bypassSecureCheck:true to force the raw (black) frame anyway.",
        ),
      };
    }
  }

  const kind = frame.nearBlack ? "black" : "single-color";
  return {
    note:
      `Note: captured frame is ~uniform ${kind} (${Math.round(frame.coverage * 100)}% one color). ` +
      `Likely a FLAG_SECURE window, a blank/loading screen, or a GPU/emulator backend issue — ` +
      `ui(action:'tree') is unaffected by FLAG_SECURE if you need the content.`,
  };
}

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
    description:
      "Take screenshot. Auto-compressed. Use diff=true to see only changes. Blank/all-black frames from FLAG_SECURE windows (banking/auth) are detected and steer you to ui(action:'tree'); pass bypassSecureCheck:true to force the raw frame.",
    schema: z.object({
      platform: platformEnum,
      compress: z
        .boolean()
        .default(true)
        .describe("Compress image (default: true). Set false for original quality."),
      // Optional (NOT .default) so an unset value stays undefined and lets
      // `preset` win; the medium default is applied last (see handler). Fixes
      // #56 where a zod default masked preset entirely.
      maxWidth: z
        .number()
        .optional()
        .describe(
          "Max width in pixels (overrides preset; default via preset or 540). Lower values reduce token cost. Max 2000 for API.",
        ),
      maxHeight: z
        .number()
        .optional()
        .describe(
          "Max height in pixels (overrides preset; default via preset or 960). Lower values reduce token cost. Max 2000 for API.",
        ),
      quality: z
        .number()
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
      bypassSecureCheck: z
        .boolean()
        .default(false)
        .describe(
          "Skip the FLAG_SECURE / blank-frame check and return the raw capture even if it's an all-black secure frame (default: false).",
        ),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = args.platform as Platform | undefined;
      const compress = args.compress !== false;
      const diffMode = args.diff === true;
      const stableMode = args.waitForStable === true;
      const diffThreshold = args.diffThreshold;
      const bypassSecureCheck = args.bypassSecureCheck === true;

      // Precedence: explicit param → preset → medium default. Because the
      // params are now optional (no zod default), an unset value is undefined
      // and preset actually takes effect (#56).
      const preset = args.preset ? SCREEN_PRESETS[args.preset] : undefined;
      const compressOptions = {
        maxWidth: args.maxWidth ?? preset?.maxWidth ?? SCREEN_PRESETS.medium.maxWidth,
        maxHeight: args.maxHeight ?? preset?.maxHeight ?? SCREEN_PRESETS.medium.maxHeight,
        quality: args.quality ?? preset?.quality ?? SCREEN_PRESETS.medium.quality,
        monitorIndex: args.monitorIndex,
        turbo: ctx.turboDefault,
      };
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";

      const captureBuffer = () =>
        ctx.deviceManager.getScreenshotBufferAsync(currentPlatform, deviceId);

      if (diffMode) {
        const pngBuffer = stableMode
          ? await waitForStableScreenshot(captureBuffer)
          : await captureBuffer();

        const advisory = await assessBlankFrame(
          pngBuffer,
          currentPlatform,
          deviceId,
          ctx,
          bypassSecureCheck,
        );
        if (advisory?.earlyReturn) return advisory.earlyReturn;

        const prevBuffer = ctx.lastScreenshotMap.get(currentPlatform);
        ctx.lastScreenshotMap.set(currentPlatform, pngBuffer);

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
      ctx.lastScreenshotMap.set(currentPlatform, pngBuffer);

      const advisory = await assessBlankFrame(
        pngBuffer,
        currentPlatform,
        deviceId,
        ctx,
        bypassSecureCheck,
      );
      if (advisory?.earlyReturn) return advisory.earlyReturn;

      if (!compress) {
        return {
          image: { data: pngBuffer.toString("base64"), mimeType: "image/png" },
          text: advisory?.note,
        } as unknown as ToolResult;
      }

      const result = await compressScreenshot(pngBuffer, compressOptions);
      const scaleX = result.originalWidth / result.width;
      const scaleY = result.originalHeight / result.height;
      const scaled = scaleX !== 1 || scaleY !== 1;

      // Store scale so interaction tools can auto-correct coordinates
      ctx.screenshotScaleMap.set(currentPlatform, { scaleX, scaleY });

      const scaleNote = scaled
        ? `Screenshot: ${result.width}x${result.height} (device: ${result.originalWidth}x${result.originalHeight}). Coordinate scaling applied automatically.`
        : undefined;
      const text = [advisory?.note, scaleNote].filter(Boolean).join("\n") || undefined;

      return {
        image: { data: result.data, mimeType: result.mimeType },
        text,
      } as unknown as ToolResult;
    },
  }),

  defineTool({
    name: "screen_burst",
    description:
      "Capture a burst of N time-ordered frames to observe MOTION over time — animations, drag-follow, reorder/transition smoothness, or short-lived states (skeleton/loading placeholders) that a single screenshot or ui(tree) can't catch. Low preset by default to bound token cost.",
    schema: z.object({
      platform: platformEnum,
      frames: z
        .number()
        .int()
        .min(2)
        .max(12)
        .default(6)
        .describe("Number of frames to capture (2-12, default 6)."),
      intervalMs: z
        .number()
        .int()
        .min(30)
        .max(2000)
        .default(150)
        .describe("Target delay between frames in ms (default 150). Actual spacing includes capture time."),
      preset: z
        .string()
        .optional()
        .describe("Quality preset low|medium|high (default: low, to keep the burst cheap)."),
      maxWidth: z.number().optional().describe("Override max width in px (else from preset)."),
      maxHeight: z.number().optional().describe("Override max height in px (else from preset)."),
      quality: z.number().optional().describe("Override JPEG quality 1-100 (else from preset)."),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const platform = (args.platform as Platform | undefined) ??
        ctx.deviceManager.getCurrentPlatform() ?? "android";
      const frames = (args.frames as number) ?? 6;
      const intervalMs = (args.intervalMs as number) ?? 150;

      const presetVals = SCREEN_PRESETS[(args.preset as string) ?? "low"] ?? SCREEN_PRESETS.low;
      const compressOptions = {
        maxWidth: (args.maxWidth as number) ?? presetVals.maxWidth,
        maxHeight: (args.maxHeight as number) ?? presetVals.maxHeight,
        quality: (args.quality as number) ?? presetVals.quality,
        turbo: ctx.turboDefault,
      };

      // Capture first (fast, back-to-back) so timing reflects the real motion;
      // compress afterwards so encode latency doesn't stretch the sampling window.
      const captured: { offsetMs: number; buf: Buffer }[] = [];
      const start = Date.now();
      for (let i = 0; i < frames; i++) {
        if (i > 0) await sleep(intervalMs);
        const buf = await ctx.deviceManager.getScreenshotBufferAsync(platform, deviceId);
        captured.push({ offsetMs: Date.now() - start, buf });
      }
      const spanMs = captured[captured.length - 1]?.offsetMs ?? 0;

      const content: Array<
        { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
      > = [
        {
          type: "text",
          text:
            `Burst: ${frames} frames over ~${spanMs}ms (target interval ${intervalMs}ms + capture time). ` +
            `Frames are time-ordered — compare consecutive frames to judge motion, trajectory, or catch short-lived states.`,
        },
      ];
      for (let i = 0; i < captured.length; i++) {
        const c = await compressScreenshot(captured[i].buf, compressOptions);
        content.push({ type: "text", text: `frame ${i + 1}/${frames} @ +${captured[i].offsetMs}ms` });
        content.push({ type: "image", data: c.data, mimeType: c.mimeType });
      }

      return { content, text: `Captured ${frames} frames over ~${spanMs}ms` } as unknown as ToolResult;
    },
  }),

  defineTool({
    name: "screen_annotate",
    description: "Screenshot with numbered bounding boxes on UI elements (Android/iOS)",
    schema: z.object({
      platform: platformEnum,
      maxWidth: z
        .number()
        .default(540)
        .describe(
          "Max width in pixels (default: 540). Lower values reduce token cost. Max 2000 for API.",
        ),
      maxHeight: z
        .number()
        .default(960)
        .describe(
          "Max height in pixels (default: 960). Lower values reduce token cost. Max 2000 for API.",
        ),
      quality: z
        .number()
        .default(55)
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
          currentPlat === "aurora"
            ? "screen(action:'annotate') is not supported for Aurora because audb has no UI accessibility hierarchy. Use screen(action:'capture') with coordinate input."
            : "screen(action:'annotate') is not supported for desktop platform.",
        );
      }

      const pngBuffer = await ctx.deviceManager.getScreenshotBufferAsync(currentPlat, deviceId);

      let uiElements: UiElement[] = [];
      if (currentPlat === "android" || !currentPlat) {
        const xml = await ctx.deviceManager.getUiHierarchyAsync("android", deviceId);
        uiElements = parseUiHierarchy(xml);
      } else if (currentPlat === "ios") {
        try {
          const json = await ctx.deviceManager.getUiHierarchy("ios", deviceId);
          const tree = JSON.parse(json);
          uiElements = ctx.iosTreeToUiElements(tree);
        } catch (iosUiErr: any) {
          console.error(
            `[annotate_screenshot] iOS UI hierarchy unavailable: ${iosUiErr?.message}`,
          );
        }
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
