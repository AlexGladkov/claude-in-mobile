import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { annotateScreenshot, compareScreenshots, cropRegion, compressScreenshot } from "../utils/image.js";
import { parseUiHierarchy, UiElement } from "../adb/ui-parser.js";

const STABLE_INTERVAL_MS = 300;
const STABLE_MAX_RETRIES = 3;
const STABLE_THRESHOLD_PERCENT = 2;

async function waitForStableScreenshot(
  getBuffer: () => Promise<Buffer>,
): Promise<Buffer> {
  let prev = await getBuffer();
  for (let i = 0; i < STABLE_MAX_RETRIES; i++) {
    await new Promise((resolve) => setTimeout(resolve, STABLE_INTERVAL_MS));
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
  {
    tool: {
      name: "screen_capture",
      description: "Take a screenshot of the device screen. FALLBACK ONLY — prefer ui_tree for inspecting UI elements (text-based, ~10x cheaper). Use screen_capture only when: visual layout verification is needed, ui_tree fails, or you need to confirm something visually. Images are auto-compressed. Use diff mode to only see what changed (saves 60-80% tokens).",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
            description: "Target platform. If not specified, uses the active target.",
          },
          compress: {
            type: "boolean",
            description: "Compress image (default: true). Set false for original quality.",
            default: true,
          },
          maxWidth: {
            type: "number",
            description: "Max width in pixels (default: 540). Lower values reduce token cost. Max 2000 for API.",
            default: 540,
          },
          maxHeight: {
            type: "number",
            description: "Max height in pixels (default: 960). Lower values reduce token cost. Max 2000 for API.",
            default: 960,
          },
          quality: {
            type: "number",
            description: "JPEG quality 1-100 (default: 55). Lower = smaller size, faster processing.",
            default: 55,
          },
          monitorIndex: {
            type: "number",
            description: "Monitor index for multi-monitor desktop setups (Desktop only). If not specified, captures all monitors.",
          },
          diff: {
            type: "boolean",
            description: "Compare with previous screenshot. Returns only changed region (<5% change = text only, 5-80% = cropped diff, >80% = full screenshot).",
            default: false,
          },
          diffThreshold: {
            type: "number",
            description: "Pixel difference threshold 0-255 for diff mode (default: 30). Lower = more sensitive.",
            default: 30,
          },
          waitForStable: {
            type: "boolean",
            description: "Wait for UI to stabilize before capturing. Takes two captures ~300ms apart and compares them; retries up to 3 times until change < 2%. Useful after navigation or animations.",
            default: false,
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const compress = args.compress !== false;
      const diffMode = args.diff === true;
      const stableMode = args.waitForStable === true;
      const diffThreshold = (args.diffThreshold as number) ?? 30;
      const compressOptions = {
        maxWidth: args.maxWidth as number | undefined,
        maxHeight: args.maxHeight as number | undefined,
        quality: args.quality as number | undefined,
        monitorIndex: args.monitorIndex as number | undefined,
      };
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";

      const captureBuffer = () => ctx.deviceManager.getScreenshotBufferAsync(currentPlatform);

      if (diffMode) {
        const pngBuffer = stableMode
          ? await waitForStableScreenshot(captureBuffer)
          : await captureBuffer();
        const prevBuffer = ctx.lastScreenshotMap.get(currentPlatform);
        ctx.lastScreenshotMap.set(currentPlatform, pngBuffer);

        if (!prevBuffer) {
          const result = compress
            ? await compressScreenshot(pngBuffer, compressOptions)
            : { data: pngBuffer.toString("base64"), mimeType: "image/png" };
          return {
            image: { data: result.data, mimeType: result.mimeType },
            text: "First screenshot (no previous to diff against)",
          };
        }

        const diff = await compareScreenshots(prevBuffer, pngBuffer, diffThreshold);

        if (diff.changePercent < 5) {
          return { text: `Screen unchanged (${diff.changePercent}% diff)` };
        }

        if (diff.changePercent >= 80 || !diff.changedRegion) {
          const result = compress
            ? await compressScreenshot(pngBuffer, compressOptions)
            : { data: pngBuffer.toString("base64"), mimeType: "image/png" };
          return {
            image: { data: result.data, mimeType: result.mimeType },
            text: `Screen changed significantly (${diff.changePercent}% diff) — full screenshot`,
          };
        }

        const croppedBuffer = await cropRegion(pngBuffer, diff.changedRegion, 20);
        const result = compress
          ? await compressScreenshot(croppedBuffer, compressOptions)
          : { data: croppedBuffer.toString("base64"), mimeType: "image/png" };
        return {
          image: { data: result.data, mimeType: result.mimeType },
          text: `Changed region (${diff.changePercent}% diff) at (${diff.changedRegion.x}, ${diff.changedRegion.y}) ${diff.changedRegion.width}x${diff.changedRegion.height}`,
        };
      }

      // Standard screenshot (non-diff) — single capture, reuse buffer
      const pngBuffer = stableMode
        ? await waitForStableScreenshot(captureBuffer)
        : await captureBuffer();
      ctx.lastScreenshotMap.set(currentPlatform, pngBuffer);

      if (!compress) {
        return {
          image: { data: pngBuffer.toString("base64"), mimeType: "image/png" },
        };
      }

      const result = await compressScreenshot(pngBuffer, compressOptions);
      const scaleX = result.originalWidth / result.width;
      const scaleY = result.originalHeight / result.height;
      const scaled = scaleX !== 1 || scaleY !== 1;

      // Store scale so interaction tools can auto-correct coordinates
      ctx.screenshotScaleMap.set(currentPlatform, { scaleX, scaleY });

      return {
        image: { data: result.data, mimeType: result.mimeType },
        text: scaled
          ? `Screenshot: ${result.width}x${result.height} (device: ${result.originalWidth}x${result.originalHeight}). Coordinate scaling applied automatically.`
          : undefined,
      };
    },
  },
  {
    tool: {
      name: "screen_annotate",
      description: "Take a screenshot with colored bounding boxes and numbered labels overlaid on UI elements. Green = clickable, Red = non-clickable. Returns annotated image + element index. Useful for visual understanding of UI layout. Android and iOS only.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
            description: "Target platform. If not specified, uses the active target.",
          },
          maxWidth: {
            type: "number",
            description: "Max width in pixels (default: 540). Lower values reduce token cost. Max 2000 for API.",
            default: 540,
          },
          maxHeight: {
            type: "number",
            description: "Max height in pixels (default: 960). Lower values reduce token cost. Max 2000 for API.",
            default: 960,
          },
          quality: {
            type: "number",
            description: "JPEG quality 1-100 (default: 55). Lower = smaller size, faster processing.",
            default: 55,
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlat = platform ?? ctx.deviceManager.getCurrentPlatform();
      if (currentPlat === "desktop" || currentPlat === "aurora") {
        return { text: `annotate_screenshot is not supported for ${currentPlat} platform. Use screenshot + get_ui instead.` };
      }

      const pngBuffer = await ctx.deviceManager.getScreenshotBufferAsync(currentPlat);

      let uiElements: UiElement[] = [];
      if (currentPlat === "android" || !currentPlat) {
        const xml = await ctx.deviceManager.getUiHierarchyAsync("android");
        uiElements = parseUiHierarchy(xml);
      } else if (currentPlat === "ios") {
        try {
          const json = await ctx.deviceManager.getUiHierarchy("ios");
          const tree = JSON.parse(json);
          uiElements = ctx.iosTreeToUiElements(tree);
        } catch (iosUiErr: any) {
          console.error(`[annotate_screenshot] iOS UI hierarchy unavailable: ${iosUiErr?.message}`);
        }
      }

      if (uiElements.length === 0) {
        const result = await compressScreenshot(pngBuffer, {
          maxWidth: args.maxWidth as number | undefined,
          maxHeight: args.maxHeight as number | undefined,
          quality: args.quality as number | undefined,
        });
        return {
          image: { data: result.data, mimeType: result.mimeType },
          text: "No UI elements found to annotate. Returning plain screenshot.",
        };
      }

      const annotResult = await annotateScreenshot(pngBuffer, uiElements, {
        maxWidth: args.maxWidth as number | undefined,
        maxHeight: args.maxHeight as number | undefined,
        quality: args.quality as number | undefined,
      });

      const elementsList = annotResult.elements
        .map(el => `  ${el.index}: ${el.clickable ? "[clickable] " : ""}${el.label} @ (${el.center.x}, ${el.center.y})`)
        .join("\n");

      return {
        image: {
          data: annotResult.image.data,
          mimeType: annotResult.image.mimeType,
        },
        text: `Annotated ${annotResult.elements.length} elements:\n${elementsList}`,
      };
    },
  },
];
