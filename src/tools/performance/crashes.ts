import { formatCrashes } from "../../perf/formatter.js";
import { truncateOutput } from "../../utils/truncate.js";
import { defineTool, z } from "../define-tool.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import { collectSnapshot, deviceIdField, platformEnum } from "./common.js";

export const performanceCrashes = defineTool({
  name: "performance_crashes",
  description: "Query recent crashes, ANRs, and native crashes from device logs.",
  schema: z.object({
    platform: platformEnum,
    packageName: z
      .string()
      .optional()
      .describe("App package name (Android). Auto-detected if not provided."),
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    const packageName = args.packageName;

    const snapshot = await collectSnapshot(ctx, platform, packageName, deviceId);
    const text = truncateOutput(formatCrashes(snapshot.crashes, platform));
    const hasCrashes = snapshot.crashes.length > 0;

    return hasCrashes ? errorResult(text) : textResult(text);
  },
});
