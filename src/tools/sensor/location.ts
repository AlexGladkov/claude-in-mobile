import { defineTool, z } from "../define-tool.js";
import { platformEnum, deviceIdField } from "../common-schema.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import { MOCK_LOCATION_GRANT } from "../../adb/commands.js";
import { dispatchByPlatform } from "../helpers/dispatch.js";
import { validateNumber, validateLatitude, validateLongitude } from "./helpers.js";

export const sensorLocationTool = defineTool({
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

    return dispatchByPlatform(platform, {
      ios: () => {
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
      },
      android: () => {
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
      unsupported: (p) =>
        textResult(`sensor_location is not supported on platform: ${p}. Supported: android, ios.`),
    });
  },
});
