import type { ToolDefinition } from "./registry.js";
import { BUILTIN_PLATFORMS, isBuiltinPlatform } from "../device-manager.js";
import type { BuiltinPlatform, Platform } from "../device-manager.js";
import { defineTool, z } from "./define-tool.js";
import { platformEnum, platformIdSchema } from "./common-schema.js";
import { textResult } from "../utils/tool-result.js";

const BUILTIN_SECTION_LABELS: Readonly<Record<BuiltinPlatform, string>> = {
  android: "Android",
  ios: "iOS",
  desktop: "Desktop",
  aurora: "Aurora",
  harmony: "HarmonyOS",
  browser: "Browser",
};

export const deviceTools: ToolDefinition[] = [
  defineTool({
    name: "device_list",
    description: "List connected devices and emulators",
    schema: z.object({
      platform: platformEnum
        .optional()
        .describe("Filter by platform. If not specified, shows all."),
    }),
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const devices = ctx.deviceManager.getDevices(platform);
      if (devices.length === 0) {
        return textResult(
          "No devices connected. Make sure the platform toolchain (ADB, Xcode, HDC, or companion) is running and a device/emulator/simulator is connected.",
        );
      }

      const activeDevice = ctx.deviceManager.getActiveDevice();
      const { target: activeTarget } = ctx.deviceManager.getTarget();

      const groups = new Map<Platform, typeof devices>();
      for (const device of devices) {
        const group = groups.get(device.platform) ?? [];
        group.push(device);
        groups.set(device.platform, group);
      }

      let result = "Connected devices:\n";
      for (const groupPlatform of BUILTIN_PLATFORMS) {
        const heading = BUILTIN_SECTION_LABELS[groupPlatform];
        const grouped = groups.get(groupPlatform);
        if (!grouped || grouped.length === 0) continue;
        result += `\n${heading}:\n`;
        for (const d of grouped) {
          const active =
            activeTarget === groupPlatform &&
            (groupPlatform === "desktop" ||
              groupPlatform === "browser" ||
              activeDevice?.id === d.id)
              ? " [ACTIVE]"
              : "";
          const detail =
            groupPlatform === "android"
              ? `${d.isSimulator ? "emulator" : "physical"}, ${d.state}`
              : groupPlatform === "ios"
                ? `${d.isSimulator ? "simulator" : "physical"}, ${d.state}`
                : groupPlatform === "harmony"
                  ? `${d.isSimulator ? "emulator" : "physical"}, ${d.state}`
                  : d.state;
          result += `  • ${d.id} - ${d.name} (${detail})${active}\n`;
        }
      }

      for (const [groupPlatform, grouped] of groups) {
        if (isBuiltinPlatform(groupPlatform)) continue;
        result += `\n${groupPlatform}:\n`;
        for (const d of grouped) {
          const active =
            activeTarget === groupPlatform && activeDevice?.id === d.id
              ? " [ACTIVE]"
              : "";
          result +=
            `  • ${d.id} - ${d.name} ` +
            `(${d.isSimulator ? "emulator" : "physical"}, ${d.state})${active}\n`;
        }
      }

      return textResult(result.trim());
    },
  }),

  defineTool({
    name: "device_set",
    description:
      "Select active device for subsequent commands. Sets global state — all following tool calls will target this device until changed. For parallel multi-device workflows, prefer passing deviceId directly to each tool call instead of using device_set, which avoids race conditions from shared mutable state.",
    schema: z.object({
      deviceId: z.string().describe("Device ID from device(action:'list')"),
      platform: platformEnum
        .optional()
        .describe("Optional platform constraint. If omitted, device IDs must be unique across platforms."),
    }),
    handler: async (args, ctx) => {
      const device = ctx.deviceManager.setDevice(args.deviceId, args.platform as Platform | undefined);
      return textResult(`Device set to: ${device.name} (${device.platform}, ${device.id})`);
    },
  }),

  defineTool({
    name: "device_set_target",
    description: "Switch active platform (built-in or installed external platform)",
    schema: z.object({
      target: platformIdSchema.describe("Target platform to switch to"),
    }),
    handler: async (args, ctx) => {
      ctx.deviceManager.setTarget(args.target as Platform);
      return textResult(`Target set to: ${args.target}`);
    },
  }),

  defineTool({
    name: "device_get_target",
    description: "Get current active platform and status",
    schema: z.object({}),
    handler: async (_args, ctx) => {
      const { target, status } = ctx.deviceManager.getTarget();
      return textResult(`Current target: ${target} (${status})`);
    },
  }),
];
