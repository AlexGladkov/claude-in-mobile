import { defineTool, z } from "../define-tool.js";
import { platformEnum, deviceIdField } from "../common-schema.js";
import { ValidationError } from "../../errors.js";
import { truncateOutput } from "../../utils/truncate.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult } from "../../utils/tool-result.js";
import { BATTERY } from "../../adb/commands.js";
import { BATTERY_STATUS_CODES } from "./constants.js";
import { validateNumber, validateBatteryLevel, pluggedCommands } from "./helpers.js";

export const sensorBatteryTool = defineTool({
  name: "sensor_battery",
  description:
    "Set battery level, charging status, and plugged state on Android. Changes persist until reset:true is used or device reboots. iOS: not supported.",
  schema: z.object({
    level: z.number().optional().describe("Battery level 0–100 (integer)"),
    status: z
      .enum(["charging", "discharging", "not-charging", "full"])
      .optional()
      .describe("Battery status"),
    plugged: z
      .enum(["ac", "usb", "wireless", "none"])
      .optional()
      .describe("Power source. 'none' disconnects all chargers."),
    reset: z
      .boolean()
      .optional()
      .describe("Reset battery state back to real hardware values (default: false)"),
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);

    if (platform !== "android") {
      return textResult(
        `sensor_battery is only supported on Android. Current platform: ${platform}.\n\nNote: iOS does not expose a public API for overriding battery state.`,
      );
    }

    const reset = args.reset ?? false;

    if (reset) {
      ctx.deviceManager.shell(BATTERY.RESET, "android", deviceId);
      const state = ctx.deviceManager.shell(BATTERY.DUMP, "android", deviceId);
      return textResult(
        `Battery state reset to real hardware values.\n\nCurrent state:\n${truncateOutput(state ?? "(no output)", { maxLines: 30 })}`,
      );
    }

    const hasLevel = args.level !== undefined;
    const hasStatus = args.status !== undefined;
    const hasPlugged = args.plugged !== undefined;

    if (!hasLevel && !hasStatus && !hasPlugged) {
      return textResult(
        "Nothing to set. Provide at least one of: level, status, plugged. Use reset:true to restore real battery state.",
      );
    }

    const results: string[] = [];

    if (hasLevel) {
      const level = validateNumber(args.level, "level");
      validateBatteryLevel(Math.round(level));
      ctx.deviceManager.shell(BATTERY.SET_LEVEL(Math.round(level)), "android", deviceId);
      results.push(`  Level set to ${Math.round(level)}%`);
    }

    if (hasStatus) {
      const status = args.status as string;
      const code = BATTERY_STATUS_CODES[status];
      if (code === undefined) {
        throw new ValidationError(`Unknown battery status: "${status}". Valid: charging, discharging, not-charging, full`);
      }
      ctx.deviceManager.shell(BATTERY.SET_STATUS(code), "android", deviceId);
      results.push(`  Status set to ${status} (code ${code})`);
    }

    if (hasPlugged) {
      const plugged = args.plugged as string;
      const cmds = pluggedCommands(plugged);
      for (const cmd of cmds) {
        ctx.deviceManager.shell(cmd, "android", deviceId);
      }
      results.push(`  Plugged set to ${plugged}`);
    }

    const state = ctx.deviceManager.shell(BATTERY.DUMP, "android", deviceId);

    return textResult(
      `Battery state updated:\n${results.join("\n")}\n\nCurrent state:\n${truncateOutput(state ?? "(no output)", { maxLines: 30 })}\n\nNote: Changes persist until 'dumpsys battery reset' or device reboot.`,
    );
  },
});
