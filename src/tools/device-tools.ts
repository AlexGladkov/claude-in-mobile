import type { ToolDefinition } from "./registry.js";
import type { Platform } from "../device-manager.js";
import { defineTool, z } from "./define-tool.js";
import { textResult } from "../utils/tool-result.js";

const platformEnum = z.enum(["android", "ios", "desktop", "aurora", "browser"]);

export const deviceTools: ToolDefinition[] = [
  defineTool({
    name: "device_list",
    description: "List connected devices and emulators",
    schema: z.object({
      platform: platformEnum
        .optional()
        .describe("Filter by platform (android/ios). If not specified, shows all."),
    }),
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const devices = ctx.deviceManager.getDevices(platform);
      if (devices.length === 0) {
        return textResult(
          "No devices connected. Make sure ADB/Xcode is running and a device/emulator/simulator is connected.",
        );
      }

      const activeDevice = ctx.deviceManager.getActiveDevice();
      const { target: activeTarget } = ctx.deviceManager.getTarget();

      const android = devices.filter((d) => d.platform === "android");
      const ios = devices.filter((d) => d.platform === "ios");
      const desktop = devices.filter((d) => d.platform === "desktop");
      const aurora = devices.filter((d) => d.platform === "aurora");
      const browser = devices.filter((d) => d.platform === "browser");

      let result = "Connected devices:\n";

      if (android.length > 0) {
        result += "\nAndroid:\n";
        for (const d of android) {
          const active =
            activeDevice?.id === d.id && activeTarget === "android" ? " [ACTIVE]" : "";
          const type = d.isSimulator ? "emulator" : "physical";
          result += `  • ${d.id} - ${d.name} (${type}, ${d.state})${active}\n`;
        }
      }

      if (ios.length > 0) {
        result += "\niOS:\n";
        for (const d of ios) {
          const active =
            activeDevice?.id === d.id && activeTarget === "ios" ? " [ACTIVE]" : "";
          const type = d.isSimulator ? "simulator" : "physical";
          result += `  • ${d.id} - ${d.name} (${type}, ${d.state})${active}\n`;
        }
      }

      if (desktop.length > 0) {
        result += "\nDesktop:\n";
        for (const d of desktop) {
          const active = activeTarget === "desktop" ? " [ACTIVE]" : "";
          result += `  • ${d.id} - ${d.name} (${d.state})${active}\n`;
        }
      }

      if (aurora.length > 0) {
        result += "\nAurora:\n";
        for (const d of aurora) {
          const active =
            activeDevice?.id === d.id && activeTarget === "aurora" ? " [ACTIVE]" : "";
          result += `  • ${d.id} - ${d.name} (${d.state})${active}\n`;
        }
      }

      if (browser.length > 0) {
        result += "\nBrowser:\n";
        for (const d of browser) {
          const active = activeTarget === "browser" ? " [ACTIVE]" : "";
          result += `  • ${d.id} - ${d.name} (${d.state})${active}\n`;
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
        .describe("Target platform. If not specified, uses the active target."),
    }),
    handler: async (args, ctx) => {
      const device = ctx.deviceManager.setDevice(args.deviceId, args.platform as Platform | undefined);
      return textResult(`Device set to: ${device.name} (${device.platform}, ${device.id})`);
    },
  }),

  defineTool({
    name: "device_set_target",
    description: "Switch active platform (android/ios/desktop/aurora/browser)",
    schema: z.object({
      target: platformEnum.describe("Target platform to switch to"),
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
