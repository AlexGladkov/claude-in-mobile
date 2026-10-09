import { MobileError } from "../errors.js";
import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { platformEnum, deviceIdField } from "./common-schema.js";
import { validatePackageName, validatePermission } from "../utils/sanitize.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult } from "../utils/tool-result.js";

const commonFields = {
  platform: platformEnum,
  deviceId: deviceIdField,
} as const;

export const permissionTools: ToolDefinition[] = [
  defineTool({
    name: "permission_grant",
    description: "Grant app permission (Android runtime / iOS privacy / Aurora Sailjail)",
    schema: z.object({
      package: z.string().describe("Package/application ID (Android/Aurora) or bundle ID (iOS)"),
      permission: z
        .string()
        .describe(
          "Permission to grant. Android: android.permission.CAMERA, android.permission.ACCESS_FINE_LOCATION, etc. iOS: camera, microphone, photos, location, contacts, calendar, reminders, motion, health, speech-recognition. Aurora: Sailjail names declared by the app, e.g. UserDirs",
        ),
      disablePrompt: z.boolean().optional().describe("Aurora only: explicitly disable the permission dialog before granting"),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validatePackageName(args.package);
      validatePermission(args.permission);
      if (args.disablePrompt !== undefined && platform !== "aurora") {
        throw new MobileError("disablePrompt is supported only for Aurora.", "INVALID_ARGUMENT");
      }
      const result = platform === "aurora" && args.disablePrompt !== undefined
        ? ctx.deviceManager.getAuroraClient(deviceId).grantPermission(args.package, args.permission, args.disablePrompt)
        : ctx.deviceManager.grantPermission(args.package, args.permission, platform, deviceId);
      return textResult(result);
    },
  }),

  defineTool({
    name: "permission_revoke",
    description: "Revoke app permission",
    schema: z.object({
      package: z.string().describe("Package/application ID (Android/Aurora) or bundle ID (iOS)"),
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
      package: z.string().describe("Package/application ID (Android/Aurora) or bundle ID (iOS)"),
      ...commonFields,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      validatePackageName(args.package);
      const result = ctx.deviceManager.resetPermissions(args.package, platform, deviceId);
      return textResult(result);
    },
  }),
  defineTool({
    name: "permission_list",
    description: "Read Aurora declared permissions, grants and prompt state",
    schema: z.object({ package: z.string(), platform: z.literal("aurora"), deviceId: deviceIdField }),
    handler: async (args, ctx) => {
      validatePackageName(args.package);
      return textResult(ctx.deviceManager.getAuroraClient(args.deviceId).permissionList(args.package));
    },
  }),
  defineTool({
    name: "permission_grant_all",
    description: "Grant only permissions declared by an Aurora app; disablePrompt must be explicit",
    schema: z.object({ package: z.string(), platform: z.literal("aurora"), deviceId: deviceIdField, disablePrompt: z.boolean().default(false) }),
    handler: async (args, ctx) => {
      validatePackageName(args.package);
      return textResult(ctx.deviceManager.getAuroraClient(args.deviceId).grantAllPermissions(args.package, args.disablePrompt));
    },
  }),
  defineTool({
    name: "permission_prompt",
    description: "Explicitly enable or disable an Aurora app's permission prompt; enabling clears grants",
    schema: z.object({ package: z.string(), platform: z.literal("aurora"), deviceId: deviceIdField, enabled: z.boolean() }),
    handler: async (args, ctx) => {
      validatePackageName(args.package);
      return textResult(ctx.deviceManager.getAuroraClient(args.deviceId).permissionPrompt(args.package, args.enabled));
    },
  }),
];
