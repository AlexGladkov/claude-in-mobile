import { truncateOutput } from "../../utils/truncate.js";
import { formatSnapshot } from "../../perf/formatter.js";
import { defineTool, z } from "../define-tool.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult } from "../../utils/tool-result.js";
import { collectSnapshot, deviceIdField, platformEnum } from "./common.js";

export const performanceSnapshot = defineTool({
  name: "performance_snapshot",
  description:
    "Collect current performance metrics: memory, CPU, FPS, battery, crash count. Returns formatted report.",
  schema: z.object({
    platform: platformEnum,
    packageName: z
      .string()
      .optional()
      .describe("App package name (Android). Auto-detected from foreground if not provided."),
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    const packageName = args.packageName;

    const snapshot = await collectSnapshot(ctx, platform, packageName, deviceId);
    const text = formatSnapshot(snapshot);

    return textResult(truncateOutput(text));
  },
});
