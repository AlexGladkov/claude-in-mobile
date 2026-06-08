import type { PerfSnapshot } from "../../perf/types.js";
import { formatMonitor } from "../../perf/formatter.js";
import { truncateOutput } from "../../utils/truncate.js";
import { PerfCollectionError } from "../../errors.js";
import { defineTool, z } from "../define-tool.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult } from "../../utils/tool-result.js";
import { sleep } from "../../utils/sleep.js";
import {
  DEFAULT_MONITOR_DURATION_MS,
  DEFAULT_MONITOR_INTERVAL_MS,
  MAX_MONITOR_DURATION_MS,
  MIN_MONITOR_INTERVAL_MS,
  aggregateSnapshots,
  collectSnapshot,
  deviceIdField,
  platformEnum,
} from "./common.js";

export const performanceMonitor = defineTool({
  name: "performance_monitor",
  description:
    "Monitor performance over a duration, collecting periodic samples. Returns min/max/avg stats.",
  schema: z.object({
    platform: platformEnum,
    packageName: z
      .string()
      .optional()
      .describe("App package name (Android). Auto-detected if not provided."),
    duration: z
      .number()
      .optional()
      .describe("Monitoring duration in ms (default: 5000, max: 30000)"),
    interval: z
      .number()
      .optional()
      .describe("Sampling interval in ms (default: 1000, min: 500)"),
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    const packageName = args.packageName;

    const duration = Math.min(
      Math.max(args.duration ?? DEFAULT_MONITOR_DURATION_MS, MIN_MONITOR_INTERVAL_MS),
      MAX_MONITOR_DURATION_MS,
    );
    const interval = Math.max(args.interval ?? DEFAULT_MONITOR_INTERVAL_MS, MIN_MONITOR_INTERVAL_MS);

    const snapshots: PerfSnapshot[] = [];
    const warnings: string[] = [];
    const startTime = Date.now();

    while (Date.now() - startTime < duration) {
      try {
        snapshots.push(await collectSnapshot(ctx, platform, packageName, deviceId));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`Sample failed: ${msg.slice(0, 100)}`);
      }

      const elapsed = Date.now() - startTime;
      if (elapsed + interval < duration) {
        await sleep(interval);
      } else {
        break;
      }
    }

    const actualDuration = Date.now() - startTime;

    if (snapshots.length === 0) {
      throw new PerfCollectionError(platform, "No samples collected during monitoring period.");
    }

    const result = aggregateSnapshots(snapshots, actualDuration, warnings);
    const text = formatMonitor(result, platform);

    return textResult(truncateOutput(text));
  },
});
