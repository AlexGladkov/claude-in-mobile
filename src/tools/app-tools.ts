import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { validatePackageName, validatePath } from "../utils/sanitize.js";

export const appTools: ToolDefinition[] = [
  {
    tool: {
      name: "app_launch",
      description: "Launch app by package name or bundle ID",
      inputSchema: {
        type: "object",
        properties: {
          package: { type: "string", description: "Package name (Android) or bundle ID (iOS), e.g., com.android.settings or com.apple.Preferences" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["package"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const deviceId = args.deviceId as string | undefined;
      validatePackageName(args.package as string);
      const result = await ctx.deviceManager.launchApp(args.package as string, platform, deviceId);
      return { text: result };
    },
  },
  {
    tool: {
      name: "app_stop",
      description: "Force stop an app",
      inputSchema: {
        type: "object",
        properties: {
          package: { type: "string", description: "Package name (Android) or bundle ID (iOS)" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["package"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const deviceId = args.deviceId as string | undefined;
      validatePackageName(args.package as string);
      ctx.deviceManager.stopApp(args.package as string, platform, deviceId);
      return { text: `Stopped: ${args.package}` };
    },
  },
  {
    tool: {
      name: "app_install",
      description: "Install APK (Android) or .app bundle (iOS)",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to APK (Android) or .app bundle (iOS)" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["path"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const deviceId = args.deviceId as string | undefined;
      validatePath(args.path as string, "install_path");
      const result = ctx.deviceManager.installApp(args.path as string, platform, deviceId);
      return { text: result };
    },
  },
  {
    tool: {
      name: "app_restart",
      description: "Force-stop then re-launch an app. Common pattern for clearing in-memory state without uninstall.",
      inputSchema: {
        type: "object",
        properties: {
          package: { type: "string", description: "Package name (Android) or bundle ID (iOS)" },
          delayMs: { type: "number", description: "Delay between stop and launch in ms (default: 500). Useful so OS releases resources.", default: 500 },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
          deviceId: { type: "string", description: "Target device ID for multi-device. If omitted, uses active device." },
        },
        required: ["package"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const deviceId = args.deviceId as string | undefined;
      const pkg = args.package as string;
      validatePackageName(pkg);
      const delayMs = Math.max(0, Math.min((args.delayMs as number) ?? 500, 10_000));

      ctx.deviceManager.stopApp(pkg, platform, deviceId);
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      const launchResult = await ctx.deviceManager.launchApp(pkg, platform, deviceId);
      return { text: `Restarted: ${pkg} (delay=${delayMs}ms). ${launchResult}` };
    },
  },
  {
    tool: {
      name: "app_list",
      description: "List installed apps (Aurora only)",
      inputSchema: {
        type: "object",
        properties: {
          platform: { const: "aurora" },
        },
        required: [],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      if (platform !== "aurora") {
        return { text: "list_apps is only available for Aurora OS." };
      }
      const packages = ctx.deviceManager.getAuroraClient().listPackages();
      return { text: `Installed packages (${packages.length}):\n${packages.join("\n")}` };
    },
  },
];
