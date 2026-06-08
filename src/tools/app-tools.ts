import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { validatePackageName, validatePath } from "../utils/sanitize.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";
import { sleep } from "../utils/sleep.js";

const platformEnum = z
  .enum(["android", "ios", "desktop", "aurora", "browser"])
  .describe("Target platform. If not specified, uses the active target.")
  .optional();

const deviceIdField = z
  .string()
  .describe("Target device ID for multi-device. If omitted, uses active device.")
  .optional();

const commonFields = {
  platform: platformEnum,
  deviceId: deviceIdField,
} as const;

export const appTools: ToolDefinition[] = [
  defineTool({
    name: "app_launch",
    description: "Launch app by package name or bundle ID",
    schema: z.object({
      package: z
        .string()
        .describe(
          "Package name (Android) or bundle ID (iOS), e.g., com.android.settings or com.apple.Preferences",
        ),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validatePackageName(args.package);
      const result = await ctx.deviceManager.launchApp(args.package, platform, deviceId);
      return textResult(result);
    },
  }),

  defineTool({
    name: "app_stop",
    description: "Force stop an app",
    schema: z.object({
      package: z.string().describe("Package name (Android) or bundle ID (iOS)"),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validatePackageName(args.package);
      ctx.deviceManager.stopApp(args.package, platform, deviceId);
      return textResult(`Stopped: ${args.package}`);
    },
  }),

  defineTool({
    name: "app_install",
    description: "Install APK (Android) or .app bundle (iOS)",
    schema: z.object({
      path: z.string().describe("Path to APK (Android) or .app bundle (iOS)"),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validatePath(args.path, "install_path");
      const result = ctx.deviceManager.installApp(args.path, platform, deviceId);
      return textResult(result);
    },
  }),

  defineTool({
    name: "app_restart",
    description:
      "Force-stop then re-launch an app. Common pattern for clearing in-memory state without uninstall.",
    schema: z.object({
      package: z.string().describe("Package name (Android) or bundle ID (iOS)"),
      delayMs: z
        .number()
        .default(500)
        .describe(
          "Delay between stop and launch in ms (default: 500). Useful so OS releases resources.",
        ),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validatePackageName(args.package);
      const delayMs = Math.max(0, Math.min(args.delayMs, 10_000));

      ctx.deviceManager.stopApp(args.package, platform, deviceId);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      const launchResult = await ctx.deviceManager.launchApp(args.package, platform, deviceId);
      return textResult(`Restarted: ${args.package} (delay=${delayMs}ms). ${launchResult}`);
    },
  }),

  defineTool({
    name: "app_list",
    description: "List installed apps (Aurora only)",
    schema: z.object({
      platform: z.literal("aurora").optional(),
    }),
    handler: async (args, ctx) => {
      const { platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      if (platform !== "aurora") {
        return textResult("list_apps is only available for Aurora OS.");
      }
      const packages = ctx.deviceManager.getAuroraClient().listPackages();
      return textResult(`Installed packages (${packages.length}):\n${packages.join("\n")}`);
    },
  }),
];
