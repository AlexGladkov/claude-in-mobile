import type { ToolDefinition } from "./registry.js";
import type { Platform } from "../device-manager.js";
import { ValidationError } from "../errors.js";
import { truncateOutput } from "../utils/truncate.js";
import { validatePackageName } from "../utils/sanitize.js";

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
  // "none" → all stay 0 (already the default above)
  return cmds;
}

/** Map battery status string to Android status code (BatteryManager constants). */
const BATTERY_STATUS_CODES: Record<string, number> = {
  charging: 2,
  discharging: 3,
  "not-charging": 4,
  full: 5,
};

/** Map thermal status string to Android thermalservice override code. */
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
// Tool definitions
// ---------------------------------------------------------------------------

export const sensorTools: ToolDefinition[] = [
  // -------------------------------------------------------------------------
  // sensor_location
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "sensor_location",
      description:
        "Set GPS location on device. Android emulator: uses 'adb emu geo fix'. iOS Simulator: uses 'xcrun simctl location'. Physical Android devices: configures mock location provider via appops. Physical iOS devices: not supported.",
      inputSchema: {
        type: "object",
        properties: {
          latitude: {
            type: "number",
            description: "Latitude in decimal degrees (-90 to 90)",
          },
          longitude: {
            type: "number",
            description: "Longitude in decimal degrees (-180 to 180)",
          },
          altitude: {
            type: "number",
            description: "Altitude in meters (default: 0)",
          },
          platform: {
            type: "string",
            enum: ["android", "ios"],
            description: "Target platform. If not specified, uses the active target.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["latitude", "longitude"],
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as Platform | undefined) ?? ctx.deviceManager.getCurrentPlatform();
      const lat = validateNumber(args.latitude, "latitude");
      const lon = validateNumber(args.longitude, "longitude");
      const alt = args.altitude !== undefined ? validateNumber(args.altitude, "altitude") : 0;

      validateLatitude(lat);
      validateLongitude(lon);

      if (platform === "ios") {
        // iOS Simulator only. Physical iOS devices cannot be driven this way.
        try {
          const result = ctx.deviceManager.shell(
            `xcrun simctl location booted set ${lat},${lon}`,
            "ios",
          );
          return {
            text: `GPS location set on iOS Simulator:\n  Latitude:  ${lat}\n  Longitude: ${lon}${result ? `\n${result.trim()}` : ""}`,
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            text: `Failed to set location on iOS Simulator: ${msg}\n\nNote: 'xcrun simctl location' requires Xcode 14+ and only works on simulators, not physical devices.`,
            isError: true,
          };
        }
      }

      if (platform !== "android") {
        return {
          text: `sensor_location is not supported on platform: ${platform}. Supported: android, ios.`,
        };
      }

      // Android: try emulator geo fix first (works on AVDs).
      // geo fix takes longitude FIRST, then latitude, then optional altitude.
      try {
        const geoResult = ctx.deviceManager.getAndroidClient(deviceId).shell(
          `emu geo fix ${lon} ${lat} ${alt}`,
        );
        const output = geoResult?.trim() ?? "";
        // AVD emu shell returns "OK" on success; non-emulators may return an error string.
        if (output === "" || output.toLowerCase() === "ok") {
          return {
            text: `GPS location set on Android emulator:\n  Latitude:  ${lat}\n  Longitude: ${lon}\n  Altitude:  ${alt}m`,
          };
        }
        // Fall through to physical-device path if the response looks like an error.
        if (output.toLowerCase().includes("error") || output.toLowerCase().includes("unknown")) {
          throw new Error(output);
        }
        return {
          text: `GPS location set:\n  Latitude:  ${lat}\n  Longitude: ${lon}\n  Altitude:  ${alt}m\n  Response: ${output}`,
        };
      } catch {
        // Physical device fallback: grant mock location to shell, then broadcast.
        try {
          ctx.deviceManager.getAndroidClient(deviceId).shell(
            "appops set com.android.shell android:mock_location allow",
          );
          // Use LocationManager test provider via am broadcast (best-effort on physical devices).
          // Coordinates are numeric-only — no injection vector.
          const broadcastResult = ctx.deviceManager.getAndroidClient(deviceId).shell(
            `am broadcast -a android.intent.action.MOCK_LOCATION --ef latitude ${lat} --ef longitude ${lon} --ef altitude ${alt}`,
          );
          return {
            text: `GPS mock location broadcast sent (physical device):\n  Latitude:  ${lat}\n  Longitude: ${lon}\n  Altitude:  ${alt}m\n  Note: App under test must use a mock location provider to receive this.\n  Result: ${(broadcastResult ?? "").trim()}`,
          };
        } catch (physErr: unknown) {
          const msg = physErr instanceof Error ? physErr.message : String(physErr);
          return {
            text: `Could not set GPS location on physical device: ${msg}\n\nFor physical Android devices, consider using a dedicated GPS mock app (e.g. 'Fake GPS location') with developer options enabled.`,
            isError: true,
          };
        }
      }
    },
  },

  // -------------------------------------------------------------------------
  // sensor_battery
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "sensor_battery",
      description:
        "Set battery level, charging status, and plugged state on Android. Changes persist until reset:true is used or device reboots. iOS: not supported.",
      inputSchema: {
        type: "object",
        properties: {
          level: {
            type: "number",
            description: "Battery level 0–100 (integer)",
          },
          status: {
            type: "string",
            enum: ["charging", "discharging", "not-charging", "full"],
            description: "Battery status",
          },
          plugged: {
            type: "string",
            enum: ["ac", "usb", "wireless", "none"],
            description: "Power source. 'none' disconnects all chargers.",
          },
          reset: {
            type: "boolean",
            description: "Reset battery state back to real hardware values (default: false)",
          },
          platform: {
            type: "string",
            enum: ["android", "ios"],
            description: "Target platform. If not specified, uses the active target.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as Platform | undefined) ?? ctx.deviceManager.getCurrentPlatform();

      if (platform !== "android") {
        return {
          text: `sensor_battery is only supported on Android. Current platform: ${platform}.\n\nNote: iOS does not expose a public API for overriding battery state.`,
        };
      }

      const reset = (args.reset as boolean | undefined) ?? false;

      if (reset) {
        ctx.deviceManager.getAndroidClient(deviceId).shell("dumpsys battery reset");
        const state = ctx.deviceManager.getAndroidClient(deviceId).shell("dumpsys battery");
        return {
          text: `Battery state reset to real hardware values.\n\nCurrent state:\n${truncateOutput(state ?? "(no output)", { maxLines: 30 })}`,
        };
      }

      const hasLevel = args.level !== undefined;
      const hasStatus = args.status !== undefined;
      const hasPlugged = args.plugged !== undefined;

      if (!hasLevel && !hasStatus && !hasPlugged) {
        return {
          text: "Nothing to set. Provide at least one of: level, status, plugged. Use reset:true to restore real battery state.",
        };
      }

      const results: string[] = [];

      if (hasLevel) {
        const level = validateNumber(args.level, "level");
        validateBatteryLevel(Math.round(level));
        ctx.deviceManager.getAndroidClient(deviceId).shell(`dumpsys battery set level ${Math.round(level)}`);
        results.push(`  Level set to ${Math.round(level)}%`);
      }

      if (hasStatus) {
        const status = args.status as string;
        const code = BATTERY_STATUS_CODES[status];
        if (code === undefined) {
          throw new ValidationError(`Unknown battery status: "${status}". Valid: charging, discharging, not-charging, full`);
        }
        ctx.deviceManager.getAndroidClient(deviceId).shell(`dumpsys battery set status ${code}`);
        results.push(`  Status set to ${status} (code ${code})`);
      }

      if (hasPlugged) {
        const plugged = args.plugged as string;
        const cmds = pluggedCommands(plugged);
        for (const cmd of cmds) {
          ctx.deviceManager.getAndroidClient(deviceId).shell(cmd);
        }
        results.push(`  Plugged set to ${plugged}`);
      }

      // Read back the current state to confirm.
      const state = ctx.deviceManager.getAndroidClient(deviceId).shell("dumpsys battery");

      return {
        text: `Battery state updated:\n${results.join("\n")}\n\nCurrent state:\n${truncateOutput(state ?? "(no output)", { maxLines: 30 })}\n\nNote: Changes persist until 'dumpsys battery reset' or device reboot.`,
      };
    },
  },

  // -------------------------------------------------------------------------
  // sensor_notifications
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "sensor_notifications",
      description:
        "Read the notification shade from Android. Returns a parsed list of active notifications with title, text, package, and time. iOS: not supported.",
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "Filter notifications by package name (e.g. com.example.app). Optional.",
          },
          platform: {
            type: "string",
            enum: ["android", "ios"],
            description: "Target platform. If not specified, uses the active target.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as Platform | undefined) ?? ctx.deviceManager.getCurrentPlatform();

      if (platform !== "android") {
        return {
          text: `sensor_notifications is only supported on Android. Current platform: ${platform}.\n\nNote: iOS does not provide a public ADB/shell API for reading the notification shade.`,
        };
      }

      const packageFilter = args.package as string | undefined;
      if (packageFilter) {
        validatePackageName(packageFilter);
      }

      const raw = ctx.deviceManager.getAndroidClient(deviceId).shell("dumpsys notification --noredact");
      if (!raw) {
        return { text: "No output from dumpsys notification." };
      }

      // Parse notification records from dumpsys output.
      // Each notification block starts with "NotificationRecord(" and contains key=value pairs.
      const notifications = parseNotifications(raw, packageFilter);

      if (notifications.length === 0) {
        const filterNote = packageFilter ? ` matching package "${packageFilter}"` : "";
        return { text: `No active notifications found${filterNote}.` };
      }

      // Limit to 20 most recent.
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

      return { text: truncateOutput(lines.join("\n"), { maxLines: 200, maxChars: 8000 }) };
    },
  },

  // -------------------------------------------------------------------------
  // sensor_thermal
  // -------------------------------------------------------------------------
  {
    tool: {
      name: "sensor_thermal",
      description:
        "Override Android thermal status (API 29+ / Android 10+). Simulates device overheating scenarios. Use reset:true to restore real thermal state. iOS: not supported.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["none", "light", "moderate", "severe", "critical", "emergency", "shutdown"],
            description: "Thermal severity level to simulate",
          },
          reset: {
            type: "boolean",
            description: "Reset thermal override back to real hardware state (default: false)",
          },
          platform: {
            type: "string",
            enum: ["android", "ios"],
            description: "Target platform. If not specified, uses the active target.",
          },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
      },
    },
    handler: async (args, ctx) => {
      const deviceId = args.deviceId as string | undefined;
      const platform = (args.platform as Platform | undefined) ?? ctx.deviceManager.getCurrentPlatform();

      if (platform !== "android") {
        return {
          text: `sensor_thermal is only supported on Android. Current platform: ${platform}.\n\nNote: iOS does not expose a public API for thermal state override.`,
        };
      }

      const reset = (args.reset as boolean | undefined) ?? false;

      if (reset) {
        try {
          ctx.deviceManager.getAndroidClient(deviceId).shell("cmd thermalservice reset");
          return { text: "Thermal override reset to real hardware state." };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            text: `Failed to reset thermal state: ${msg}\n\nNote: 'cmd thermalservice' requires Android 10 (API 29) or higher.`,
            isError: true,
          };
        }
      }

      if (!args.status) {
        return {
          text: "Provide a 'status' to set, or use reset:true to restore real thermal state.\nValid statuses: none, light, moderate, severe, critical, emergency, shutdown",
        };
      }

      const status = args.status as string;
      const code = THERMAL_STATUS_CODES[status];
      if (code === undefined) {
        throw new ValidationError(
          `Unknown thermal status: "${status}". Valid: none, light, moderate, severe, critical, emergency, shutdown`,
        );
      }

      try {
        const result = ctx.deviceManager.getAndroidClient(deviceId).shell(
          `cmd thermalservice override-status ${code}`,
        );
        const output = (result ?? "").trim();

        // Detect API < 29: thermalservice will print an error or empty
        if (output.toLowerCase().includes("error") || output.toLowerCase().includes("not found")) {
          return {
            text: `Thermal override failed: ${output}\n\nNote: 'cmd thermalservice override-status' requires Android 10 (API 29) or higher. Check your device API level with: adb shell getprop ro.build.version.sdk`,
            isError: true,
          };
        }

        return {
          text: `Thermal status set to "${status}" (code ${code}).${output ? `\nDevice response: ${output}` : ""}\n\nNote: Use reset:true to restore real thermal state when done testing.`,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          text: `Failed to set thermal status: ${msg}\n\nNote: 'cmd thermalservice override-status' requires Android 10 (API 29) or higher. Check your device API level with: adb shell getprop ro.build.version.sdk`,
          isError: true,
        };
      }
    },
  },
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

/**
 * Extract notification records from 'dumpsys notification --noredact' output.
 *
 * The output format is not stable across Android versions, so we use heuristic
 * line-by-line parsing. Key fields are extracted where present.
 */
function parseNotifications(raw: string, packageFilter?: string): ParsedNotification[] {
  const results: ParsedNotification[] = [];

  // Split into blocks separated by "NotificationRecord(" lines.
  // Each record block contains indented properties.
  const lines = raw.split(/\r?\n/);

  let current: ParsedNotification | null = null;

  for (const line of lines) {
    // New record starts at "  NotificationRecord(" or "NotificationRecord("
    const recordMatch = line.match(/NotificationRecord\(.*?pkg=([^\s,)]+)/);
    if (recordMatch) {
      if (current) results.push(current);
      current = { pkg: recordMatch[1] };
      continue;
    }

    if (!current) continue;

    // android.title
    const titleMatch = line.match(/android\.title[=:]\s*(.+)/);
    if (titleMatch && !current.title) {
      current.title = cleanNotifValue(titleMatch[1]);
      continue;
    }

    // android.text
    const textMatch = line.match(/android\.text[=:]\s*(.+)/);
    if (textMatch && !current.text) {
      current.text = cleanNotifValue(textMatch[1]);
      continue;
    }

    // when= (epoch ms) — convert to readable time
    const whenMatch = line.match(/\bwhen=(\d+)/);
    if (whenMatch && !current.when) {
      const ms = parseInt(whenMatch[1], 10);
      if (ms > 1_000_000_000_000) {
        // Reasonable epoch ms (after year 2001)
        current.when = new Date(ms).toISOString();
      }
      continue;
    }

    // priority=
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

/** Strip trailing parens, quotes, and whitespace from a parsed dumpsys value. */
function cleanNotifValue(raw: string): string {
  return raw
    .replace(/^\s+|\s+$/g, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\s*\).*$/, "")
    .slice(0, 256);
}
