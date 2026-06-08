import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { Jimp } from "jimp";
import { defineTool, z } from "./define-tool.js";
import { BaselineStore, BaselineEntry } from "../utils/baseline-store.js";
import {
  generateDiffOverlay,
  compressScreenshot,
  compareScreenshots,
} from "../utils/image.js";
import type { DiffRegion } from "../utils/image.js";
import { createLazySingleton } from "../utils/lazy.js";
import { ValidationError } from "../errors.js";
import { sleep } from "../utils/sleep.js";
import { SCREEN } from "../constants/timeouts.js";
import { textResult, errorResult, type ToolResult } from "../utils/tool-result.js";

const getStore = createLazySingleton(() => new BaselineStore());

const STABLE_THRESHOLD_PERCENT = 2;

async function waitForStableScreenshot(getBuffer: () => Promise<Buffer>): Promise<Buffer> {
  let prev = await getBuffer();
  for (let i = 0; i < SCREEN.STABLE_MAX_RETRIES; i++) {
    await sleep(SCREEN.STABLE_INTERVAL_MS);
    const next = await getBuffer();
    const diff = await compareScreenshots(prev, next, 30);
    if (diff.changePercent < STABLE_THRESHOLD_PERCENT) return next;
    prev = next;
  }
  return prev;
}

async function captureScreenshot(
  ctx: ToolContext,
  platform: Platform | undefined,
  waitStable: boolean,
): Promise<{ buffer: Buffer; platform: string; width: number; height: number }> {
  const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";
  const getBuffer = () => ctx.deviceManager.getScreenshotBufferAsync(currentPlatform);
  const buffer = waitStable ? await waitForStableScreenshot(getBuffer) : await getBuffer();
  const img = await Jimp.read(buffer);
  return { buffer, platform: currentPlatform, width: img.width, height: img.height };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatEntry(e: BaselineEntry): string {
  const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
  const date = e.updatedAt.split("T")[0];
  return `${e.name} (${e.platform}) — ${e.width}x${e.height}, ${formatSize(e.fileSize)}, ${date}${tags}`;
}

const platformEnum = z
  .enum(["android", "ios", "desktop", "aurora", "browser"])
  .optional();

const deviceIdField = z
  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();

const ignoreRegionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const visualTools: ToolDefinition[] = [
  defineTool({
    name: "visual_baseline_save",
    description: "Save current screenshot as visual baseline for regression testing",
    schema: z.object({
      name: z.string().describe("Baseline name (e.g. 'login-screen')"),
      platform: platformEnum.describe("Target platform"),
      tags: z.array(z.string()).optional().describe("Tags for grouping"),
      overwrite: z
        .boolean()
        .default(false)
        .describe("Overwrite existing baseline (default: false)"),
      waitForStable: z
        .boolean()
        .default(true)
        .describe("Wait for UI stabilization (default: true)"),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      if (!args.name) throw new ValidationError("name is required for baseline_save");
      const platform = args.platform as Platform | undefined;
      const waitStable = args.waitForStable !== false;

      const capture = await captureScreenshot(ctx, platform, waitStable);
      const entry = await getStore().save(args.name, capture.platform, capture.buffer, {
        tags: args.tags,
        overwrite: args.overwrite === true,
        width: capture.width,
        height: capture.height,
      });

      return textResult(`Baseline saved: ${formatEntry(entry)}`);
    },
  }),

  defineTool({
    name: "visual_compare",
    description: "Compare current screen with saved baseline. Returns diff overlay on mismatch.",
    schema: z.object({
      name: z.string().describe("Baseline name to compare against"),
      platform: platformEnum,
      threshold: z.number().default(1.0).describe("Max allowed change % (default: 1.0)"),
      diffThreshold: z.number().default(30).describe("Pixel sensitivity 0-255 (default: 30)"),
      ignoreRegions: z
        .array(ignoreRegionSchema)
        .optional()
        .describe("Regions to exclude (e.g. status bar, clock)"),
      waitForStable: z
        .boolean()
        .default(true)
        .describe("Wait for UI stabilization (default: true)"),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      if (!args.name) throw new ValidationError("name is required for compare");
      const platform = args.platform as Platform | undefined;
      const threshold = args.threshold;
      const diffThreshold = args.diffThreshold;
      const ignoreRegions = args.ignoreRegions as DiffRegion[] | undefined;
      const waitStable = args.waitForStable !== false;

      const capture = await captureScreenshot(ctx, platform, waitStable);
      const baselineBuffer = await getStore().get(args.name, capture.platform);

      const diff = await generateDiffOverlay(baselineBuffer, capture.buffer, {
        threshold: diffThreshold,
        ignoreRegions,
      });

      if (diff.changePercent <= threshold) {
        return textResult(
          `PASS: ${args.name} (${capture.platform}) — ${diff.changePercent}% diff (threshold: ${threshold}%)`,
        );
      }

      const compressed = await compressScreenshot(diff.image);
      const regionsText = diff.regions
        .map((r, i) => `  [${i + 1}] (${r.x},${r.y}) ${r.width}x${r.height}`)
        .join("\n");

      return {
        image: { data: compressed.data, mimeType: compressed.mimeType },
        text: `FAIL: ${args.name} (${capture.platform}) — ${diff.changePercent}% diff (threshold: ${threshold}%). Regions: ${diff.regions.length}\n${regionsText}`,
        isError: true,
      } as unknown as ToolResult;
    },
  }),

  defineTool({
    name: "visual_baseline_update",
    description: "Update existing baseline with current screenshot",
    schema: z.object({
      name: z.string().describe("Baseline name to update"),
      platform: platformEnum,
      reason: z.string().optional().describe("Reason for update (recorded in metadata)"),
      waitForStable: z
        .boolean()
        .default(true)
        .describe("Wait for UI stabilization (default: true)"),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      if (!args.name) throw new ValidationError("name is required for baseline_update");
      const platform = args.platform as Platform | undefined;
      const waitStable = args.waitForStable !== false;

      const capture = await captureScreenshot(ctx, platform, waitStable);
      const entry = await getStore().update(args.name, capture.platform, capture.buffer);

      const reason = args.reason ? ` Reason: ${args.reason}` : "";
      return textResult(`Baseline updated: ${formatEntry(entry)}.${reason}`);
    },
  }),

  defineTool({
    name: "visual_list",
    description: "List saved visual baselines",
    schema: z.object({
      platform: platformEnum.describe("Filter by platform"),
      tag: z.string().optional().describe("Filter by tag"),
      deviceId: deviceIdField,
    }),
    handler: async (args) => {
      const platform = args.platform as string | undefined;
      const entries = await getStore().list(platform, args.tag);

      if (entries.length === 0) {
        const filter = [platform, args.tag].filter(Boolean).join(", ");
        return textResult(
          `No baselines found${filter ? ` (filter: ${filter})` : ""}. Use visual(action:'baseline_save') to create one.`,
        );
      }

      const header = `Visual baselines${platform ? ` (${platform})` : ""}: ${entries.length} total`;
      const list = entries.map((e, i) => `  ${i + 1}. ${formatEntry(e)}`).join("\n");
      return textResult(`${header}\n${list}`);
    },
  }),

  defineTool({
    name: "visual_delete",
    description: "Delete a visual baseline",
    schema: z.object({
      name: z.string().describe("Baseline name to delete"),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      if (!args.name) throw new ValidationError("name is required for delete");
      const platform =
        (args.platform as string | undefined) ??
        ctx.deviceManager.getCurrentPlatform() ??
        "android";

      await getStore().delete(args.name, platform);
      return textResult(`Deleted baseline: ${args.name} (${platform})`);
    },
  }),

  defineTool({
    name: "visual_suite",
    description:
      "Run visual comparison for all baselines matching filters (batch regression check)",
    schema: z.object({
      platform: platformEnum,
      tag: z.string().optional().describe("Filter baselines by tag"),
      threshold: z.number().default(1.0).describe("Max allowed change % (default: 1.0)"),
      stopOnFail: z
        .boolean()
        .default(false)
        .describe("Stop on first failure (default: false)"),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const platform = args.platform as string | undefined;
      const threshold = args.threshold;
      const stopOnFail = args.stopOnFail === true;

      const entries = await getStore().list(platform, args.tag);
      if (entries.length === 0) {
        return textResult(
          "No baselines found for suite. Use visual(action:'baseline_save') to create baselines first.",
        );
      }

      const currentPlatform = (platform ??
        ctx.deviceManager.getCurrentPlatform() ??
        "android") as Platform;
      const currentBuffer = await ctx.deviceManager.getScreenshotBufferAsync(currentPlatform);

      const results: Array<{ name: string; status: "PASS" | "FAIL" | "ERROR"; detail: string }> =
        [];

      for (const entry of entries) {
        if (entry.platform !== currentPlatform) continue;
        try {
          const baselineBuffer = await getStore().get(entry.name, entry.platform);
          const diff = await generateDiffOverlay(baselineBuffer, currentBuffer, {
            threshold: 30,
          });

          if (diff.changePercent <= threshold) {
            results.push({ name: entry.name, status: "PASS", detail: `${diff.changePercent}%` });
          } else {
            results.push({
              name: entry.name,
              status: "FAIL",
              detail: `${diff.changePercent}% (${diff.regions.length} regions)`,
            });
            if (stopOnFail) break;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ name: entry.name, status: "ERROR", detail: msg.slice(0, 100) });
        }
      }

      const passed = results.filter((r) => r.status === "PASS").length;
      const failed = results.filter((r) => r.status === "FAIL").length;
      const errors = results.filter((r) => r.status === "ERROR").length;

      const lines = results.map((r) => `  ${r.status}: ${r.name} — ${r.detail}`).join("\n");
      const summary = `Visual suite (${currentPlatform}): ${passed} passed, ${failed} failed${errors > 0 ? `, ${errors} errors` : ""}`;

      const body = `${summary}\n${lines}`;
      return failed > 0 ? errorResult(body) : textResult(body);
    },
  }),
];
