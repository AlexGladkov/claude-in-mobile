import { defineTool, z } from "../define-tool.js";
import { platformEnum, deviceIdField } from "../common-schema.js";
import { ValidationError } from "../../errors.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import { THERMAL_STATUS_CODES } from "./constants.js";

export const sensorThermalTool = defineTool({
  name: "sensor_thermal",
  description:
    "Override Android thermal status (API 29+ / Android 10+). Simulates device overheating scenarios. Use reset:true to restore real thermal state. iOS: not supported.",
  schema: z.object({
    status: z
      .string()
      .optional()
      .describe(
        "Thermal severity level to simulate. One of: none, light, moderate, severe, critical, emergency, shutdown",
      ),
    reset: z
      .boolean()
      .optional()
      .describe("Reset thermal override back to real hardware state (default: false)"),
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);

    if (platform !== "android") {
      return textResult(
        `sensor_thermal is only supported on Android. Current platform: ${platform}.\n\nNote: iOS does not expose a public API for thermal state override.`,
      );
    }

    const reset = args.reset ?? false;

    if (reset) {
      try {
        ctx.deviceManager.shell("cmd thermalservice reset", "android", deviceId);
        return textResult("Thermal override reset to real hardware state.");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(
          `Failed to reset thermal state: ${msg}\n\nNote: 'cmd thermalservice' requires Android 10 (API 29) or higher.`,
        );
      }
    }

    if (!args.status) {
      return textResult(
        "Provide a 'status' to set, or use reset:true to restore real thermal state.\nValid statuses: none, light, moderate, severe, critical, emergency, shutdown",
      );
    }

    const status = args.status;
    const code = THERMAL_STATUS_CODES[status];
    if (code === undefined) {
      throw new ValidationError(
        `Unknown thermal status: "${status}". Valid: none, light, moderate, severe, critical, emergency, shutdown`,
      );
    }

    try {
      const result = ctx.deviceManager.shell(
        `cmd thermalservice override-status ${code}`,
        "android",
        deviceId,
      );
      const output = (result ?? "").trim();

      if (output.toLowerCase().includes("error") || output.toLowerCase().includes("not found")) {
        return errorResult(
          `Thermal override failed: ${output}\n\nNote: 'cmd thermalservice override-status' requires Android 10 (API 29) or higher. Check your device API level with: adb shell getprop ro.build.version.sdk`,
        );
      }

      return textResult(
        `Thermal status set to "${status}" (code ${code}).${output ? `\nDevice response: ${output}` : ""}\n\nNote: Use reset:true to restore real thermal state when done testing.`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(
        `Failed to set thermal status: ${msg}\n\nNote: 'cmd thermalservice override-status' requires Android 10 (API 29) or higher. Check your device API level with: adb shell getprop ro.build.version.sdk`,
      );
    }
  },
});
