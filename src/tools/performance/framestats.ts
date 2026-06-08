import { detectForegroundPackage } from "../../perf/collector.js";
import { truncateOutput } from "../../utils/truncate.js";
import { ValidationError, PerfCollectionError } from "../../errors.js";
import { validatePackageName } from "../../utils/sanitize.js";
import { defineTool, z } from "../define-tool.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult } from "../../utils/tool-result.js";
import { sleep } from "../../utils/sleep.js";
import {
  deviceIdField,
  formatFrameStats,
  parseFrameStats,
  platformEnum,
} from "./common.js";

export const performanceFramestats = defineTool({
  name: "performance_framestats",
  description:
    "Collect frame rendering statistics from GPU profiling. Returns frame time percentiles (p50/p90/p99), jank rate, and slow render percentage. Android only.",
  schema: z.object({
    platform: platformEnum,
    packageName: z
      .string()
      .optional()
      .describe("App package name. Auto-detected from foreground if not provided."),
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);

    if (platform !== "android") {
      throw new ValidationError(
        `performance_framestats is Android-only. Current platform: "${platform}".`,
      );
    }

    const adb = ctx.deviceManager.getAndroidClient(deviceId);
    let pkg = args.packageName;
    if (!pkg) {
      pkg = detectForegroundPackage(adb);
    }
    if (!pkg) {
      throw new PerfCollectionError(
        "android",
        "Could not detect foreground package. Provide packageName explicitly.",
      );
    }
    validatePackageName(pkg);

    // Reset gfxinfo stats
    adb.exec(`shell dumpsys gfxinfo ${pkg} reset`);
    await sleep(100);

    // Collect framestats
    const rawOutput: string = adb.exec(`shell dumpsys gfxinfo ${pkg} framestats`);

    const stats = parseFrameStats(rawOutput);
    const text = formatFrameStats(stats, pkg);

    return textResult(truncateOutput(text));
  },
});
