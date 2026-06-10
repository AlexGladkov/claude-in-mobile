import { validatePackageName, validatePath, sanitizeForShell } from "../../utils/sanitize.js";
import { truncateOutput } from "../../utils/truncate.js";
import { defineTool, z } from "../define-tool.js";
import { deviceIdField } from "../common-schema.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import {
  androidPlatformEnum,
  isRunAsFailure,
  looksLikeBinary,
  runAsUnavailableHint,
} from "./helpers.js";

export const sandboxFileReadTool = defineTool({
  name: "sandbox_file_read",
  description:
    "Read the contents of a file from an app's private sandbox via adb run-as. " +
    "Binary files are detected automatically and reported as such. " +
    "Only works on debuggable apps or userdebug/eng device builds.",
  schema: z.object({
    package: z.string().describe("App package name, e.g. com.example.app"),
    path: z
      .string()
      .describe(
        'Relative path to the file inside the sandbox, e.g. "files/config.json" or "databases/app.db".',
      ),
    maxBytes: z
      .number()
      .optional()
      .describe("Maximum characters of file content to return (default: 10000, max: 50000)."),
    platform: androidPlatformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    if (platform !== "android") {
      return errorResult("sandbox_file_read is only available on Android.");
    }

    const pkg = args.package;
    validatePackageName(pkg);

    const rawPath = args.path;
    validatePath(rawPath, "path");
    const safePath = sanitizeForShell(rawPath);
    if (safePath.length === 0) {
      return errorResult("Invalid path after sanitization.");
    }

    const maxBytes = Math.min(Math.max(1, args.maxBytes ?? 10_000), 50_000);

    let content: string;
    try {
      content = ctx.deviceManager.shell(`run-as ${pkg} cat ${safePath}`, "android", deviceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isRunAsFailure(msg)) return errorResult(runAsUnavailableHint(pkg));
      if (msg.toLowerCase().includes("no such file")) {
        return errorResult(`File not found: "${safePath}" in sandbox of "${pkg}".`);
      }
      return errorResult(`Failed to read file: ${msg}`);
    }

    if (isRunAsFailure(content)) return errorResult(runAsUnavailableHint(pkg));

    if (looksLikeBinary(content)) {
      return textResult(
        `File "${safePath}" in "${pkg}" appears to be a binary file and cannot be displayed as text.\n\n` +
          "If this is a SQLite database, use sandbox(action:'sqlite_query') instead.",
      );
    }

    return textResult(truncateOutput(content, { maxChars: maxBytes, maxLines: 1000 }));
  },
});
