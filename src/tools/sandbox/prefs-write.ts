import { validatePackageName, validatePath, sanitizeForShell } from "../../utils/sanitize.js";
import { defineTool, z } from "../define-tool.js";
import { deviceIdField } from "../common-schema.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import { androidPlatformEnum, isRunAsFailure, runAsUnavailableHint } from "./helpers.js";

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

    const type = args.type ?? "string";

    const xmlPath = `shared_prefs/${safeFile}.xml`;

    // Build sed replacement pattern based on type.
    // <string name="key">value</string>  — string type (value in inner text)
    // <int name="key" value="123" />     — numeric/bool types (value in attribute)
    let sedCmd: string;
    if (type === "string") {
      sedCmd =
        `run-as ${pkg} sed -i ` +
        `'s|<string name="${safeKey}">[^<]*</string>|<string name="${safeKey}">${safeValue}</string>|' ` +
        xmlPath;
    } else {
      // int / long / float / bool all use value="..." attribute form
      const xmlTag = type === "bool" ? "boolean" : type;
      sedCmd =
        `run-as ${pkg} sed -i ` +
        `'s|<${xmlTag} name="${safeKey}" value="[^"]*" />|<${xmlTag} name="${safeKey}" value="${safeValue}" />|' ` +
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
