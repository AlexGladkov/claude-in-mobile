import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";

export const deviceTools: ToolDefinition[] = [
  {
    tool: {
      name: "device_list",
      description: "List all connected Android devices/emulators and iOS simulators",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
            description: "Filter by platform (android/ios). If not specified, shows all.",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const devices = ctx.deviceManager.getDevices(platform);
      if (devices.length === 0) {
        return { text: "No devices connected. Make sure ADB/Xcode is running and a device/emulator/simulator is connected." };
      }

      const activeDevice = ctx.deviceManager.getActiveDevice();
      const { target: activeTarget } = ctx.deviceManager.getTarget();

      const android = devices.filter(d => d.platform === "android");
      const ios = devices.filter(d => d.platform === "ios");
      const desktop = devices.filter(d => d.platform === "desktop");
      const aurora = devices.filter(d => d.platform === "aurora");
      const browser = devices.filter(d => d.platform === "browser");

      let result = "Connected devices:\n";

      if (android.length > 0) {
        result += "\nAndroid:\n";
        for (const d of android) {
          const active = activeDevice?.id === d.id && activeTarget === "android" ? " [ACTIVE]" : "";
          const type = d.isSimulator ? "emulator" : "physical";
          result += `  • ${d.id} - ${d.name} (${type}, ${d.state})${active}\n`;
        }
      }

      if (ios.length > 0) {
        result += "\niOS:\n";
        for (const d of ios) {
          const active = activeDevice?.id === d.id && activeTarget === "ios" ? " [ACTIVE]" : "";
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
          const active = activeDevice?.id === d.id && activeTarget === "aurora" ? " [ACTIVE]" : "";
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

      return { text: result.trim() };
    },
  },
  {
    tool: {
      name: "device_set",
      description: "Select which device to use for subsequent commands",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: {
            type: "string",
            description: "Device ID from list_devices",
          },
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
            description: "Target platform. If not specified, uses the active target.",
          },
        },
        required: ["deviceId"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const device = await ctx.deviceManager.setDevice(args.deviceId as string, platform);
      return { text: `Device set to: ${device.name} (${device.platform}, ${device.id})` };
    },
  },
  {
    tool: {
      name: "device_set_target",
      description: "Switch the active target between Android, iOS, Desktop, and Aurora platforms",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
            description: "Target platform to switch to",
          },
        },
        required: ["target"],
      },
    },
    handler: async (args, ctx) => {
      const target = args.target as Platform;
      ctx.deviceManager.setTarget(target);
      return { text: `Target set to: ${target}` };
    },
  },
  {
    tool: {
      name: "device_get_target",
      description: "Get the current active target and its status",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    handler: async (_args, ctx) => {
      const { target, status } = ctx.deviceManager.getTarget();
      return { text: `Current target: ${target} (${status})` };
    },
  },
];
