import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { ValidationError } from "../errors.js";
import { truncateOutput } from "../utils/truncate.js";
import { validatePackageName } from "../utils/sanitize.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult, errorResult } from "../utils/tool-result.js";
import { BATTERY, MOCK_LOCATION_GRANT } from "../adb/commands.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validateNumber(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) {
    throw new ValidationError(`${label} must be a valid number, got: ${String(value)}`);
  }
  return n;
}

function validateLatitude(lat: number): void {
  if (lat < -90 || lat > 90) {
    throw new ValidationError(`latitude must be between -90 and 90, got: ${lat}`);
  }
}

function validateLongitude(lon: number): void {
  if (lon < -180 || lon > 180) {
    throw new ValidationError(`longitude must be between -180 and 180, got: ${lon}`);
  }
}

function validateBatteryLevel(level: number): void {
  if (!Number.isInteger(level) || level < 0 || level > 100) {
    throw new ValidationError(`battery level must be an integer 0–100, got: ${level}`);
  }
}

/** Map plugged string to the dumpsys set commands. */
function pluggedCommands(plugged: string): string[] {
  const cmds: string[] = [
    "dumpsys battery set ac 0",
    "dumpsys battery set usb 0",
    "dumpsys battery set wireless 0",
  ];
  if (plugged === "ac") cmds[0] = "dumpsys battery set ac 1";
  else if (plugged === "usb") cmds[1] = "dumpsys battery set usb 1";
  else if (plugged === "wireless") cmds[2] = "dumpsys battery set wireless 1";
  return cmds;
}

const BATTERY_STATUS_CODES: Record<string, number> = {
  charging: 2,
  discharging: 3,
  "not-charging": 4,
  full: 5,
};

const THERMAL_STATUS_CODES: Record<string, number> = {
  none: 0,
  light: 1,
  moderate: 2,
  severe: 3,
  critical: 4,
  emergency: 5,
  shutdown: 6,
};

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

const platformEnum = z
  .enum(["android", "ios", "desktop", "aurora", "browser"])
  .describe("Target platform. If not specified, uses the active target.")
  .optional();

const deviceIdField = z
  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const sensorTools: ToolDefinition[] = [
  defineTool({
    name: "sensor_location",
    description:
      "Set GPS location on device. Android emulator: uses 'adb emu geo fix'. iOS Simulator: uses 'xcrun simctl location'. Physical Android devices: configures mock location provider via appops. Physical iOS devices: not supported.",
    schema: z.object({
      latitude: z.unknown().describe("Latitude in decimal degrees (-90 to 90)"),
      longitude: z.unknown().describe("Longitude in decimal degrees (-180 to 180)"),
      altitude: z.unknown().optional().describe("Altitude in meters (default: 0)"),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const lat = validateNumber(args.latitude, "latitude");
      const lon = validateNumber(args.longitude, "longitude");
      const alt = args.altitude !== undefined ? validateNumber(args.altitude, "altitude") : 0;

      validateLatitude(lat);
      validateLongitude(lon);

      if (platform === "ios") {
        try {
          const result = ctx.deviceManager.shell(
            `xcrun simctl location booted set ${lat},${lon}`,
            "ios",
          );
          return textResult(
            `GPS location set on iOS Simulator:\n  Latitude:  ${lat}\n  Longitude: ${lon}${result ? `\n${result.trim()}` : ""}`,
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult(
            `Failed to set location on iOS Simulator: ${msg}\n\nNote: 'xcrun simctl location' requires Xcode 14+ and only works on simulators, not physical devices.`,
          );
        }
      }

      if (platform !== "android") {
        return textResult(
          `sensor_location is not supported on platform: ${platform}. Supported: android, ios.`,
        );
      }

      try {
        const geoResult = ctx.deviceManager.shell(
          `emu geo fix ${lon} ${lat} ${alt}`,
          "android",
          deviceId,
        );
        const output = geoResult?.trim() ?? "";
        if (output === "" || output.toLowerCase() === "ok") {
          return textResult(
            `GPS location set on Android emulator:\n  Latitude:  ${lat}\n  Longitude: ${lon}\n  Altitude:  ${alt}m`,
          );
        }
        if (output.toLowerCase().includes("error") || output.toLowerCase().includes("unknown")) {
          throw new Error(output);
        }
        return textResult(
          `GPS location set:\n  Latitude:  ${lat}\n  Longitude: ${lon}\n  Altitude:  ${alt}m\n  Response: ${output}`,
        );
      } catch {
        try {
          ctx.deviceManager.shell(MOCK_LOCATION_GRANT, "android", deviceId);
          const broadcastResult = ctx.deviceManager.shell(
            `am broadcast -a android.intent.action.MOCK_LOCATION --ef latitude ${lat} --ef longitude ${lon} --ef altitude ${alt}`,
            "android",
            deviceId,
          );
          return textResult(
            `GPS mock location broadcast sent (physical device):\n  Latitude:  ${lat}\n  Longitude: ${lon}\n  Altitude:  ${alt}m\n  Note: App under test must use a mock location provider to receive this.\n  Result: ${(broadcastResult ?? "").trim()}`,
          );
        } catch (physErr: unknown) {
          const msg = physErr instanceof Error ? physErr.message : String(physErr);
          return errorResult(
            `Could not set GPS location on physical device: ${msg}\n\nFor physical Android devices, consider using a dedicated GPS mock app (e.g. 'Fake GPS location') with developer options enabled.`,
          );
        }
      }
    },
  }),

  defineTool({
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
  }),

  defineTool({
    name: "sensor_notifications",
    description:
      "Read the notification shade from Android. Returns a parsed list of active notifications with title, text, package, and time. iOS: not supported.",
    schema: z.object({
      package: z
        .string()
        .optional()
        .describe("Filter notifications by package name (e.g. com.example.app). Optional."),
      platform: platformEnum,
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);

      if (platform !== "android") {
        return textResult(
          `sensor_notifications is only supported on Android. Current platform: ${platform}.\n\nNote: iOS does not provide a public ADB/shell API for reading the notification shade.`,
        );
      }

      const packageFilter = args.package;
      if (packageFilter) {
        validatePackageName(packageFilter);
      }

      const raw = ctx.deviceManager.shell("dumpsys notification --noredact", "android", deviceId);
      if (!raw) {
        return textResult("No output from dumpsys notification.");
      }

      const notifications = parseNotifications(raw, packageFilter);

      if (notifications.length === 0) {
        const filterNote = packageFilter ? ` matching package "${packageFilter}"` : "";
        return textResult(`No active notifications found${filterNote}.`);
      }

      const limited = notifications.slice(0, 20);
      const lines: string[] = [`Notifications (${limited.length} shown${notifications.length > 20 ? `, ${notifications.length} total` : ""}):`];

      for (let i = 0; i < limited.length; i++) {
        const n = limited[i];
        lines.push(`\n[${i + 1}] ${n.pkg}`);
        if (n.title) lines.push(`  Title:    ${n.title}`);
        if (n.text) lines.push(`  Text:     ${n.text}`);
        if (n.when) lines.push(`  When:     ${n.when}`);
        if (n.priority !== undefined) lines.push(`  Priority: ${n.priority}`);
      }

      return textResult(truncateOutput(lines.join("\n"), { maxLines: 200, maxChars: 8000 }));
    },
  }),

  defineTool({
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
  }),
];

// ---------------------------------------------------------------------------
// Notification parser
// ---------------------------------------------------------------------------

interface ParsedNotification {
  pkg: string;
  title?: string;
  text?: string;
  when?: string;
  priority?: number;
}

function parseNotifications(raw: string, packageFilter?: string): ParsedNotification[] {
  const results: ParsedNotification[] = [];

  const lines = raw.split(/\r?\n/);

  let current: ParsedNotification | null = null;

  for (const line of lines) {
    const recordMatch = line.match(/NotificationRecord\(.*?pkg=([^\s,)]+)/);
    if (recordMatch) {
      if (current) results.push(current);
      current = { pkg: recordMatch[1] };
      continue;
    }

    if (!current) continue;

    const titleMatch = line.match(/android\.title[=:]\s*(.+)/);
    if (titleMatch && !current.title) {
      current.title = cleanNotifValue(titleMatch[1]);
      continue;
    }

    const textMatch = line.match(/android\.text[=:]\s*(.+)/);
    if (textMatch && !current.text) {
      current.text = cleanNotifValue(textMatch[1]);
      continue;
    }

    const whenMatch = line.match(/\bwhen=(\d+)/);
    if (whenMatch && !current.when) {
      const ms = parseInt(whenMatch[1], 10);
      if (ms > 1_000_000_000_000) {
        current.when = new Date(ms).toISOString();
      }
      continue;
    }

    const priorityMatch = line.match(/\bpriority=(-?\d+)/);
    if (priorityMatch && current.priority === undefined) {
      current.priority = parseInt(priorityMatch[1], 10);
      continue;
    }
  }

  if (current) results.push(current);

  if (packageFilter) {
    return results.filter(n => n.pkg === packageFilter || n.pkg.startsWith(packageFilter));
  }

  return results;
}

function cleanNotifValue(raw: string): string {
  return raw
    .replace(/^\s+|\s+$/g, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\s*\).*$/, "")
    .slice(0, 256);
}
