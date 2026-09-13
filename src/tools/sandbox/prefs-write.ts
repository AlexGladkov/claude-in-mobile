import { validatePackageName } from "../../utils/sanitize.js";
import { buildDeviceShellCommand } from "../../utils/device-shell.js";
import { defineTool, z } from "../define-tool.js";
import { deviceIdField } from "../common-schema.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import {
  androidPlatformEnum,
  isRunAsFailure,
  runAsUnavailableHint,
  validatePreferenceKey,
  validatePreferenceName,
  validatePreferenceValue,
} from "./helpers.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeSedRegex(value: string): string {
  return value.replace(/[\\.^$*+?()[\]{}|]/g, "\\$&");
}

function escapeSedReplacement(value: string): string {
  return value.replace(/[\\&|]/g, "\\$&");
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

    const file = args.file;
    validatePreferenceName(file);

    const key = args.key;
    validatePreferenceKey(key);

    const value = args.value;
    const type = args.type ?? "string";
    validatePreferenceValue(value, type);

    const sedKey = escapeSedRegex(key);
    const sedValue = escapeSedReplacement(escapeXml(value));
    const xmlPath = `shared_prefs/${file}.xml`;

    // Build sed replacement pattern based on type.
    // <string name="key">value</string>  — string type (value in inner text)
    // <int name="key" value="123" />     — numeric/bool types (value in attribute)
    let sedProgram: string;
    if (type === "string") {
      sedProgram =
        `s|<string name="${sedKey}">[^<]*</string>|` +
        `<string name="${key}">${sedValue}</string>|`;
    } else {
      const xmlTag = type === "bool" ? "boolean" : type;
      sedProgram =
        `s|<${xmlTag} name="${sedKey}" value="[^"]*" />|` +
        `<${xmlTag} name="${key}" value="${sedValue}" />|`;
    }

    let output: string;
    try {
      output = ctx.deviceManager.shell(
        buildDeviceShellCommand(["run-as", pkg, "sed", "-i", sedProgram, xmlPath]),
        "android",
        deviceId,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isRunAsFailure(msg)) return errorResult(runAsUnavailableHint(pkg));
      return errorResult("Failed to write SharedPreferences.");
    }

    if (isRunAsFailure(output)) return errorResult(runAsUnavailableHint(pkg));

    return textResult(
      `Preference updated in "${pkg}" / "${file}.xml".\n` +
        `  key  = ${key}\n` +
        `  type = ${type}\n\n` +
        "NOTE: The app must be restarted for changes to take effect.",
    );
  },
});
