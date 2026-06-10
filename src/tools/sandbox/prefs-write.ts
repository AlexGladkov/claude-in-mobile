import { validatePackageName, validatePath, sanitizeForShell } from "../../utils/sanitize.js";
import { defineTool, z } from "../define-tool.js";
import { deviceIdField } from "../common-schema.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import { androidPlatformEnum, isRunAsFailure, runAsUnavailableHint } from "./helpers.js";

/**
 * Escape a value for safe interpolation into a device-side single-quoted
 * `sed 's|...|...|'` program run via `adb shell run-as`.
 *
 * `sanitizeForShell` strips host-side shell metacharacters but intentionally
 * leaves the single-quote `'` and double-quote `"` untouched (it is shared by
 * read/list/intent tools where stripping quotes would change behaviour). Here
 * the sanitized value lands inside a POSIX single-quoted sed program on the
 * device, so a literal `'` would terminate that quote and break the command
 * (correctness + run-as-scoped injection). We close/escape/reopen the single
 * quote (`'\''`) and escape `"`, which is part of the XML attribute pattern,
 * so it cannot disturb sed's `s|...|...|` delimiters or the surrounding XML.
 */
function escapeForSedSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''").replace(/"/g, '\\"');
}

export const sandboxPrefsWriteTool = defineTool({
  name: "sandbox_prefs_write",
  description:
    "Write or update a single value in an app's SharedPreferences XML via adb run-as. " +
    "Uses sed to replace the target key in-place inside the XML file. " +
    "The app must be restarted after writing for changes to take effect. " +
    "Only works on debuggable apps or userdebug/eng device builds.",
  schema: z.object({
    package: z.string().describe("App package name, e.g. com.example.app"),
    file: z
      .string()
      .describe('SharedPreferences file name without .xml extension, e.g. "preferences"'),
    key: z.string().describe("Preference key to write"),
    value: z.string().describe("New value to set"),
    type: z
      .enum(["string", "int", "bool", "float", "long"])
      .optional()
      .describe("Value type (default: string). Determines the XML element tag used."),
    platform: androidPlatformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    if (platform !== "android") {
      return errorResult("sandbox_prefs_write is only available on Android.");
    }

    const pkg = args.package;
    validatePackageName(pkg);

    const rawFile = args.file;
    validatePath(rawFile, "file");
    const safeFile = sanitizeForShell(rawFile);
    if (safeFile.length === 0) {
      return errorResult("Invalid file name after sanitization.");
    }

    const rawKey = args.key;
    const safeKey = sanitizeForShell(rawKey);
    if (safeKey.length === 0) {
      return errorResult("Invalid key after sanitization.");
    }

    const rawValue = args.value;
    const safeValue = sanitizeForShell(rawValue);

    // safeKey/safeValue are interpolated into a device-side single-quoted
    // sed program (`sed 's|...|...|'`). sanitizeForShell leaves `'` and `"`
    // in place, so escape them for that single-quoted context to prevent the
    // value from breaking out of the quotes or disturbing sed delimiters.
    const sedKey = escapeForSedSingleQuote(safeKey);
    const sedValue = escapeForSedSingleQuote(safeValue);

    const type = args.type ?? "string";

    const xmlPath = `shared_prefs/${safeFile}.xml`;

    // Build sed replacement pattern based on type.
    // <string name="key">value</string>  — string type (value in inner text)
    // <int name="key" value="123" />     — numeric/bool types (value in attribute)
    let sedCmd: string;
    if (type === "string") {
      sedCmd =
        `run-as ${pkg} sed -i ` +
        `'s|<string name="${sedKey}">[^<]*</string>|<string name="${sedKey}">${sedValue}</string>|' ` +
        xmlPath;
    } else {
      // int / long / float / bool all use value="..." attribute form
      const xmlTag = type === "bool" ? "boolean" : type;
      sedCmd =
        `run-as ${pkg} sed -i ` +
        `'s|<${xmlTag} name="${sedKey}" value="[^"]*" />|<${xmlTag} name="${sedKey}" value="${sedValue}" />|' ` +
        xmlPath;
    }

    let output: string;
    try {
      output = ctx.deviceManager.shell(sedCmd, "android", deviceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isRunAsFailure(msg)) return errorResult(runAsUnavailableHint(pkg));
      return errorResult(`Failed to write preference: ${msg}`);
    }

    if (isRunAsFailure(output)) return errorResult(runAsUnavailableHint(pkg));

    return textResult(
      `Preference updated in "${pkg}" / "${safeFile}.xml":\n` +
        `  key   = ${safeKey}\n` +
        `  value = ${safeValue}\n` +
        `  type  = ${type}\n\n` +
        "NOTE: The app must be restarted for the change to take effect. " +
        "Use app(action:'restart', package:'<pkg>') or force-stop and relaunch.",
    );
  },
});
