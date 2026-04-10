import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";

export const appTools: ToolDefinition[] = [
  {
    tool: {
      name: "app_launch",
      description: "Launch an app by package name (Android) or bundle ID (iOS)",
      inputSchema: {
        type: "object",
        properties: {
          package: { type: "string", description: "Package name (Android) or bundle ID (iOS), e.g., com.android.settings or com.apple.Preferences" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["package"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const result = await ctx.deviceManager.launchApp(args.package as string, platform);
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
        },
        required: ["package"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      await ctx.deviceManager.stopApp(args.package as string, platform);
      return { text: `Stopped: ${args.package}` };
    },
  },
  {
    tool: {
      name: "app_install",
      description: "Install an app. APK for Android, .app bundle for iOS simulator",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to APK (Android) or .app bundle (iOS)" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["path"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const result = await ctx.deviceManager.installApp(args.path as string, platform);
      return { text: result };
    },
  },
  {
    tool: {
      name: "app_list",
      description: "List installed applications on the device",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "aurora"], description: "Target platform" },
        },
        required: [],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const currentPlatform = platform ?? ctx.deviceManager.getCurrentPlatform();

      if (currentPlatform === "aurora") {
        const packages = ctx.deviceManager.getAuroraClient().listPackages();
        return { text: `Installed packages (${packages.length}):\n${packages.join("\n")}` };
      }

      if (ctx.deviceManager.isSonicMode() && (currentPlatform === "android" || currentPlatform === "ios")) {
        const apps = await ctx.deviceManager.getAppList(platform);
        if (apps.length === 0) {
          return { text: "No apps found or unable to retrieve app list." };
        }
        const formatted = apps.map(a =>
          `${a.appName} (${a.packageName})${a.versionName ? ` - v${a.versionName}` : ""}`
        ).join("\n");
        return { text: `Installed apps (${apps.length}):\n${formatted}` };
      }

      return { text: `app_list is not supported for ${currentPlatform} in non-Sonic mode.` };
    },
  },
];
