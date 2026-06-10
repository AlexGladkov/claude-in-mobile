import { validatePackageName, validatePath, sanitizeForShell } from "../../utils/sanitize.js";
import { truncateOutput } from "../../utils/truncate.js";
import { defineTool, z } from "../define-tool.js";
import { deviceIdField } from "../common-schema.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import { androidPlatformEnum, isRunAsFailure, runAsUnavailableHint } from "./helpers.js";

export const sandboxFileListTool = defineTool({
  name: "sandbox_file_list",
  description:
    "List files inside an app's private sandbox directory via adb run-as. " +
    "Equivalent to `ls -la` inside /data/data/<package>/. " +
    "Only works on debuggable apps or userdebug/eng device builds.",
  schema: z.object({
    package: z.string().describe("App package name, e.g. com.example.app"),
    path: z
      .string()
      .optional()
      .describe(
        'Relative path inside the sandbox to list (default: "."). ' +
          'Examples: "databases", "shared_prefs", "files/cache".',
      ),
    platform: androidPlatformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    if (platform !== "android") {
      return errorResult("sandbox_file_list is only available on Android.");
    }

    const pkg = args.package;
    validatePackageName(pkg);

    const rawPath = args.path ?? ".";
    validatePath(rawPath, "path");
    const safePath = sanitizeForShell(rawPath) || ".";

    let output: string;
    try {
      output = ctx.deviceManager.shell(`run-as ${pkg} ls -la ${safePath}`, "android", deviceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isRunAsFailure(msg)) return errorResult(runAsUnavailableHint(pkg));
      return errorResult(`Failed to list directory: ${msg}`);
    }

    if (isRunAsFailure(output)) return errorResult(runAsUnavailableHint(pkg));

    return textResult(
      truncateOutput(
        `Sandbox listing for "${pkg}" / "${safePath}":\n\n${output || "(empty directory)"}`,
        { maxChars: 15000, maxLines: 300 },
      ),
    );
  },
});
