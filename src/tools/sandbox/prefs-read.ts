import { validatePackageName, validatePath, sanitizeForShell } from "../../utils/sanitize.js";
import { truncateOutput } from "../../utils/truncate.js";
import { defineTool, z } from "../define-tool.js";
import { deviceIdField } from "../common-schema.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import { androidPlatformEnum, isRunAsFailure, runAsUnavailableHint } from "./helpers.js";

export const sandboxPrefsReadTool = defineTool({
  name: "sandbox_prefs_read",
  description:
    "Read SharedPreferences XML from an app's private sandbox via adb run-as. " +
    "Parses the XML and returns a formatted key-value list. " +
    "If no file is specified, lists all available preference files first. " +
    "Only works on debuggable apps or userdebug/eng device builds.",
  schema: z.object({
    package: z.string().describe("App package name, e.g. com.example.app"),
    file: z
      .string()
      .optional()
      .describe(
        'SharedPreferences file name without .xml extension, e.g. "preferences" or "user_settings". ' +
          "If omitted, lists available files.",
      ),
    platform: androidPlatformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    if (platform !== "android") {
      return errorResult("sandbox_prefs_read is only available on Android.");
    }

    const pkg = args.package;
    validatePackageName(pkg);

    // No file specified — list available preference files first.
    if (!args.file) {
      let listOutput: string;
      try {
        listOutput = ctx.deviceManager.shell(`run-as ${pkg} ls shared_prefs/`, "android", deviceId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRunAsFailure(msg)) return errorResult(runAsUnavailableHint(pkg));
        return errorResult(`Failed to list shared_prefs: ${msg}`);
      }

      if (isRunAsFailure(listOutput)) return errorResult(runAsUnavailableHint(pkg));

      const files = listOutput
        .split("\n")
        .map(l => l.trim())
        .filter(l => l.endsWith(".xml"));

      if (files.length === 0) {
        return textResult(`No SharedPreferences files found for "${pkg}".`);
      }

      return textResult(
        `Available SharedPreferences files for "${pkg}":\n` +
          files.map(f => `  - ${f.replace(/\.xml$/, "")}`).join("\n") +
          "\n\nRe-run with file:<name> to read a specific file.",
      );
    }

    // Validate and sanitize the file name.
    const rawFile = args.file;
    validatePath(rawFile, "file");
    const safeFile = sanitizeForShell(rawFile);
    if (safeFile.length === 0) {
      return errorResult("Invalid file name after sanitization.");
    }

    let xmlContent: string;
    try {
      xmlContent = ctx.deviceManager.shell(`run-as ${pkg} cat shared_prefs/${safeFile}.xml`, "android", deviceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isRunAsFailure(msg)) return errorResult(runAsUnavailableHint(pkg));
      return errorResult(`Failed to read preferences: ${msg}`);
    }

    if (isRunAsFailure(xmlContent)) return errorResult(runAsUnavailableHint(pkg));
    if (!xmlContent || xmlContent.trim().length === 0) {
      return textResult(`File "shared_prefs/${safeFile}.xml" is empty or does not exist.`);
    }

    // Parse key-value pairs from Android SharedPreferences XML.
    // Supports <string>, <int>, <long>, <float>, <boolean>, <set> tags.
    const entries: string[] = [];
    const tagRe =
      /<(string|int|long|float|boolean|set)\s+name="([^"]+)"(?:\s+value="([^"]*)")?(?:\s*>([^<]*)<\/\1>|\s*\/>)/g;
    let match: RegExpExecArray | null;

    while ((match = tagRe.exec(xmlContent)) !== null) {
      const type = match[1];
      const name = match[2];
      const attrValue = match[3];
      const innerText = match[4]?.trim();

      let displayValue: string;
      if (type === "string") {
        displayValue = `"${innerText ?? ""}"`;
      } else if (type === "set") {
        // <set> contains multiple <string> children
        const items = Array.from((innerText ?? "").matchAll(/<string>([^<]*)<\/string>/g)).map(
          m => m[1],
        );
        displayValue = `[${items.map(s => `"${s}"`).join(", ")}]`;
      } else {
        displayValue = attrValue ?? innerText ?? "(empty)";
      }

      entries.push(`  ${name} (${type}) = ${displayValue}`);
    }

    if (entries.length === 0) {
      // Return raw XML if parsing yielded nothing (unusual format).
      return textResult(
        `No parseable entries found in "${safeFile}.xml". Raw content:\n\n${truncateOutput(xmlContent, { maxChars: 5000 })}`,
      );
    }

    return textResult(
      `SharedPreferences: "${pkg}" / "${safeFile}.xml"\n` +
        `${entries.length} entries:\n\n` +
        entries.join("\n"),
    );
  },
});
