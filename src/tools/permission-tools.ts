import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { validatePackageName, validatePermission } from "../utils/sanitize.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";

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

export const permissionTools: ToolDefinition[] = [
  defineTool({
    name: "permission_grant",
    description: "Grant app permission (Android runtime / iOS privacy)",
    schema: z.object({
      package: z.string().describe("Package name (Android) or bundle ID (iOS)"),
      permission: z
        .string()
        .describe(
          "Permission to grant. Android: android.permission.CAMERA, android.permission.ACCESS_FINE_LOCATION, etc. iOS: camera, microphone, photos, location, contacts, calendar, reminders, motion, health, speech-recognition",
        ),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validatePackageName(args.package);
      validatePermission(args.permission);
      const result = ctx.deviceManager.grantPermission(
        args.package,
        args.permission,
        platform,
        deviceId,
      );
      return textResult(result);
    },
  }),

  defineTool({
    name: "permission_revoke",
    description: "Revoke app permission",
    schema: z.object({
      package: z.string().describe("Package name (Android) or bundle ID (iOS)"),
      permission: z
        .string()
        .describe("Permission to revoke. Same values as grant_permission"),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validatePackageName(args.package);
      validatePermission(args.permission);
      const result = ctx.deviceManager.revokePermission(
        args.package,
        args.permission,
        platform,
        deviceId,
      );
      return textResult(result);
    },
  }),

  defineTool({
    name: "permission_reset",
    description: "Reset all permissions for an app",
    schema: z.object({
      package: z.string().describe("Package name (Android) or bundle ID (iOS)"),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validatePackageName(args.package);
      const result = ctx.deviceManager.resetPermissions(args.package, platform, deviceId);
      return textResult(result);
    },
  }),
];
