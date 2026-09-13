import { validatePackageName, validateSandboxPath } from "../../utils/sanitize.js";
import { buildDeviceShellCommand } from "../../utils/device-shell.js";
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

    const path = args.path ?? ".";
    validateSandboxPath(path);

    let output: string;
    try {
      output = ctx.deviceManager.shell(
        buildDeviceShellCommand(["run-as", pkg, "ls", "-la", path]),
        "android",
        deviceId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isRunAsFailure(msg)) return errorResult(runAsUnavailableHint(pkg));
      return errorResult("Failed to list sandbox directory.");
    }

    if (isRunAsFailure(output)) return errorResult(runAsUnavailableHint(pkg));

    return textResult(
      truncateOutput(
        `Sandbox listing for "${pkg}" / "${path}":\n\n${output || "(empty directory)"}`,
        { maxChars: 15000, maxLines: 300 },
      ),
    );
  },
});
