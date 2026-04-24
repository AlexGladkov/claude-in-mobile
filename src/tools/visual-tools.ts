import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { Jimp } from "jimp";
import { BaselineStore, BaselineEntry } from "../utils/baseline-store.js";
import { generateDiffOverlay, compressScreenshot, compareScreenshots, cropRegion } from "../utils/image.js";
import type { DiffRegion } from "../utils/image.js";
import { createLazySingleton } from "../utils/lazy.js";
import { ValidationError } from "../errors.js";

const getStore = createLazySingleton(() => new BaselineStore());

const STABLE_INTERVAL_MS = 300;
const STABLE_MAX_RETRIES = 3;
const STABLE_THRESHOLD_PERCENT = 2;

async function waitForStableScreenshot(
  getBuffer: () => Promise<Buffer>,
): Promise<Buffer> {
  let prev = await getBuffer();
  for (let i = 0; i < STABLE_MAX_RETRIES; i++) {
    await new Promise((r) => setTimeout(r, STABLE_INTERVAL_MS));
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

export const visualTools: ToolDefinition[] = [
  // 1. baseline_save
  {
    tool: {
      name: "visual_baseline_save",
      description: "Save current screenshot as visual baseline for regression testing",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Baseline name (e.g. 'login-screen')" },
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
            description: "Target platform",
          },
          tags: { type: "array", items: { type: "string" }, description: "Tags for grouping" },
          overwrite: { type: "boolean", description: "Overwrite existing baseline (default: false)", default: false },
          waitForStable: { type: "boolean", description: "Wait for UI stabilization (default: true)", default: true },
        },
        required: ["name"],
      },
    },
    handler: async (args, ctx) => {
      const name = args.name as string;
      if (!name) throw new ValidationError("name is required for baseline_save");
      const platform = args.platform as Platform | undefined;
      const tags = args.tags as string[] | undefined;
      const overwrite = args.overwrite === true;
      const waitStable = args.waitForStable !== false;

      const capture = await captureScreenshot(ctx, platform, waitStable);
      const entry = await getStore().save(name, capture.platform, capture.buffer, {
        tags,
        overwrite,
        width: capture.width,
        height: capture.height,
      });

      return { text: `Baseline saved: ${formatEntry(entry)}` };
    },
  },

  // 2. compare
  {
    tool: {
      name: "visual_compare",
      description: "Compare current screen with saved baseline. Returns diff overlay on mismatch.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Baseline name to compare against" },
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
          },
          threshold: { type: "number", description: "Max allowed change % (default: 1.0)", default: 1.0 },
          diffThreshold: { type: "number", description: "Pixel sensitivity 0-255 (default: 30)", default: 30 },
          ignoreRegions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                x: { type: "number" }, y: { type: "number" },
                width: { type: "number" }, height: { type: "number" },
              },
              required: ["x", "y", "width", "height"],
            },
            description: "Regions to exclude (e.g. status bar, clock)",
          },
          waitForStable: { type: "boolean", description: "Wait for UI stabilization (default: true)", default: true },
        },
        required: ["name"],
      },
    },
    handler: async (args, ctx) => {
      const name = args.name as string;
      if (!name) throw new ValidationError("name is required for compare");
      const platform = args.platform as Platform | undefined;
      const threshold = (args.threshold as number) ?? 1.0;
      const diffThreshold = (args.diffThreshold as number) ?? 30;
      const ignoreRegions = args.ignoreRegions as DiffRegion[] | undefined;
      const waitStable = args.waitForStable !== false;

      const capture = await captureScreenshot(ctx, platform, waitStable);
      const baselineBuffer = await getStore().get(name, capture.platform);

      const diff = await generateDiffOverlay(baselineBuffer, capture.buffer, {
        threshold: diffThreshold,
        ignoreRegions,
      });

      if (diff.changePercent <= threshold) {
        return { text: `PASS: ${name} (${capture.platform}) — ${diff.changePercent}% diff (threshold: ${threshold}%)` };
      }

      // FAIL — return diff overlay image
      const compressed = await compressScreenshot(diff.image);
      const regionsText = diff.regions
        .map((r, i) => `  [${i + 1}] (${r.x},${r.y}) ${r.width}x${r.height}`)
        .join("\n");

      return {
        image: { data: compressed.data, mimeType: compressed.mimeType },
        text: `FAIL: ${name} (${capture.platform}) — ${diff.changePercent}% diff (threshold: ${threshold}%). Regions: ${diff.regions.length}\n${regionsText}`,
        isError: true,
      };
    },
  },

  // 3. baseline_update
  {
    tool: {
      name: "visual_baseline_update",
      description: "Update existing baseline with current screenshot",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Baseline name to update" },
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
          },
          reason: { type: "string", description: "Reason for update (recorded in metadata)" },
          waitForStable: { type: "boolean", description: "Wait for UI stabilization (default: true)", default: true },
        },
        required: ["name"],
      },
    },
    handler: async (args, ctx) => {
      const name = args.name as string;
      if (!name) throw new ValidationError("name is required for baseline_update");
      const platform = args.platform as Platform | undefined;
      const waitStable = args.waitForStable !== false;

      const capture = await captureScreenshot(ctx, platform, waitStable);
      const entry = await getStore().update(name, capture.platform, capture.buffer);

      const reason = args.reason ? ` Reason: ${args.reason}` : "";
      return { text: `Baseline updated: ${formatEntry(entry)}.${reason}` };
    },
  },

  // 4. list
  {
    tool: {
      name: "visual_list",
      description: "List saved visual baselines",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
            description: "Filter by platform",
          },
          tag: { type: "string", description: "Filter by tag" },
        },
      },
    },
    handler: async (args) => {
      const platform = args.platform as string | undefined;
      const tag = args.tag as string | undefined;
      const entries = await getStore().list(platform, tag);

      if (entries.length === 0) {
        const filter = [platform, tag].filter(Boolean).join(", ");
        return { text: `No baselines found${filter ? ` (filter: ${filter})` : ""}. Use visual(action:'baseline_save') to create one.` };
      }

      const header = `Visual baselines${platform ? ` (${platform})` : ""}: ${entries.length} total`;
      const list = entries.map((e, i) => `  ${i + 1}. ${formatEntry(e)}`).join("\n");
      return { text: `${header}\n${list}` };
    },
  },

  // 5. delete
  {
    tool: {
      name: "visual_delete",
      description: "Delete a visual baseline",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Baseline name to delete" },
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
          },
        },
        required: ["name"],
      },
    },
    handler: async (args, ctx) => {
      const name = args.name as string;
      if (!name) throw new ValidationError("name is required for delete");
      const platform = (args.platform as string) ?? ctx.deviceManager.getCurrentPlatform() ?? "android";

      await getStore().delete(name, platform);
      return { text: `Deleted baseline: ${name} (${platform})` };
    },
  },

  // 6. suite
  {
    tool: {
      name: "visual_suite",
      description: "Run visual comparison for all baselines matching filters (batch regression check)",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
          },
          tag: { type: "string", description: "Filter baselines by tag" },
          threshold: { type: "number", description: "Max allowed change % (default: 1.0)", default: 1.0 },
          stopOnFail: { type: "boolean", description: "Stop on first failure (default: false)", default: false },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as string | undefined;
      const tag = args.tag as string | undefined;
      const threshold = (args.threshold as number) ?? 1.0;
      const stopOnFail = args.stopOnFail === true;

      const entries = await getStore().list(platform, tag);
      if (entries.length === 0) {
        return { text: "No baselines found for suite. Use visual(action:'baseline_save') to create baselines first." };
      }

      // Take one screenshot of current screen
      const currentPlatform = (platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android") as Platform;
      const currentBuffer = await ctx.deviceManager.getScreenshotBufferAsync(currentPlatform);

      const results: Array<{ name: string; status: "PASS" | "FAIL" | "ERROR"; detail: string }> = [];

      for (const entry of entries) {
        if (entry.platform !== currentPlatform) continue;
        try {
          const baselineBuffer = await getStore().get(entry.name, entry.platform);
          const diff = await generateDiffOverlay(baselineBuffer, currentBuffer, { threshold: 30 });

          if (diff.changePercent <= threshold) {
            results.push({ name: entry.name, status: "PASS", detail: `${diff.changePercent}%` });
          } else {
            results.push({ name: entry.name, status: "FAIL", detail: `${diff.changePercent}% (${diff.regions.length} regions)` });
            if (stopOnFail) break;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ name: entry.name, status: "ERROR", detail: msg.slice(0, 100) });
        }
      }

      const passed = results.filter(r => r.status === "PASS").length;
      const failed = results.filter(r => r.status === "FAIL").length;
      const errors = results.filter(r => r.status === "ERROR").length;

      const lines = results.map(r => `  ${r.status}: ${r.name} — ${r.detail}`).join("\n");
      const summary = `Visual suite (${currentPlatform}): ${passed} passed, ${failed} failed${errors > 0 ? `, ${errors} errors` : ""}`;

      return {
        text: `${summary}\n${lines}`,
        ...(failed > 0 ? { isError: true } : {}),
      };
    },
  },
];
