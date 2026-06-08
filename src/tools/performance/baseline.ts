import type { PerfSnapshot } from "../../perf/types.js";
import { formatSnapshot } from "../../perf/formatter.js";
import { truncateOutput } from "../../utils/truncate.js";
import { validateBaselineName } from "../../utils/sanitize.js";
import { defineTool, z } from "../define-tool.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult } from "../../utils/tool-result.js";
import { sleep } from "../../utils/sleep.js";
import {
  averageSnapshots,
  collectSnapshot,
  deviceIdField,
  getStore,
  platformEnum,
} from "./common.js";

export const performanceBaseline = defineTool({
  name: "performance_baseline",
  description:
    "Save current performance metrics as a named baseline for later comparison.",
  schema: z.object({
    name: z
      .string({ error: "name is required for baseline" })
      .min(1, "name is required for baseline")
      .describe("Baseline name (e.g. 'login-flow', 'idle-state')"),
    platform: platformEnum,
    packageName: z
      .string()
      .optional()
      .describe("App package name (Android). Auto-detected if not provided."),
    overwrite: z
      .boolean()
      .optional()
      .describe("Overwrite existing baseline (default: false)"),
    samples: z
      .number()
      .optional()
      .describe("Number of samples to average (default: 3, max: 10)"),
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    const name = args.name;
    validateBaselineName(name, "baseline_name");

    const packageName = args.packageName;
    const overwrite = args.overwrite === true;
    const sampleCount = Math.min(Math.max(args.samples ?? 3, 1), 10);

    // Collect multiple samples and average
    const snapshots: PerfSnapshot[] = [];
    for (let i = 0; i < sampleCount; i++) {
      snapshots.push(await collectSnapshot(ctx, platform, packageName, deviceId));
      if (i < sampleCount - 1) {
        await sleep(500);
      }
    }

    const averaged = averageSnapshots(snapshots);
    const baseline = await getStore().save(name, platform, averaged, overwrite);

    const text = `Performance baseline saved: ${baseline.name} (${baseline.platform})\n${formatSnapshot(baseline.snapshot)}`;
    return textResult(truncateOutput(text));
  },
});
