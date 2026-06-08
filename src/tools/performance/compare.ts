import type { PerfCompareResult } from "../../perf/types.js";
import { formatCompare } from "../../perf/formatter.js";
import { truncateOutput } from "../../utils/truncate.js";
import { validateBaselineName } from "../../utils/sanitize.js";
import { defineTool, z } from "../define-tool.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import {
  DEFAULT_THRESHOLDS,
  buildCompareMetrics,
  collectSnapshot,
  deviceIdField,
  getStore,
  platformEnum,
} from "./common.js";

export const performanceCompare = defineTool({
  name: "performance_compare",
  description:
    "Compare current performance against a saved baseline. Returns PASS/FAIL per metric with thresholds.",
  schema: z.object({
    name: z
      .string({ error: "name is required for compare" })
      .min(1, "name is required for compare")
      .describe("Baseline name to compare against"),
    platform: platformEnum,
    packageName: z
      .string()
      .optional()
      .describe("App package name (Android). Auto-detected if not provided."),
    memoryThreshold: z
      .number()
      .optional()
      .describe("Max allowed memory change % (default: 20)"),
    cpuThreshold: z
      .number()
      .optional()
      .describe("Max allowed CPU change % (default: 30)"),
    fpsThreshold: z
      .number()
      .optional()
      .describe("Max allowed FPS drop % (default: 10)"),
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    const name = args.name;
    validateBaselineName(name, "baseline_name");

    const packageName = args.packageName;

    const thresholds = {
      memory: args.memoryThreshold ?? DEFAULT_THRESHOLDS.memory,
      cpu: args.cpuThreshold ?? DEFAULT_THRESHOLDS.cpu,
      fps: args.fpsThreshold ?? DEFAULT_THRESHOLDS.fps,
    };

    const baseline = await getStore().get(name, platform);
    const current = await collectSnapshot(ctx, platform, packageName, deviceId);

    const metrics = buildCompareMetrics(baseline.snapshot, current, thresholds);
    const hasFail = metrics.some((m) => m.status === "FAIL");

    const result: PerfCompareResult = {
      status: hasFail ? "FAIL" : "PASS",
      baselineName: `${name} (${platform})`,
      metrics,
    };

    const text = truncateOutput(formatCompare(result));
    return hasFail ? errorResult(text) : textResult(text);
  },
});
