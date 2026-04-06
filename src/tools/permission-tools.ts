import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";

export const permissionTools: ToolDefinition[] = [
  {
    tool: {
      name: "permission_grant",
      description: "Grant a permission to an app. Android: runtime permissions (e.g., android.permission.CAMERA). iOS: privacy services (e.g., camera, microphone, photos, location, contacts, calendar, reminders)",
      inputSchema: {
        type: "object",
        properties: {
          package: { type: "string", description: "Package name (Android) or bundle ID (iOS)" },
          permission: { type: "string", description: "Permission to grant. Android: android.permission.CAMERA, android.permission.ACCESS_FINE_LOCATION, etc. iOS: camera, microphone, photos, location, contacts, calendar, reminders, motion, health, speech-recognition" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["package", "permission"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const result = ctx.deviceManager.grantPermission(
        args.package as string,
        args.permission as string,
        platform
      );
      return { text: result };
    },
  },
  {
    tool: {
      name: "permission_revoke",
      description: "Revoke a permission from an app. Android: runtime permissions. iOS: privacy services",
      inputSchema: {
        type: "object",
        properties: {
          package: { type: "string", description: "Package name (Android) or bundle ID (iOS)" },
          permission: { type: "string", description: "Permission to revoke. Same values as grant_permission" },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["package", "permission"],
      },
    },
    handler: async (args, ctx) => {
      const platform = args.platform as Platform | undefined;
      const result = ctx.deviceManager.revokePermission(
        args.package as string,
        args.permission as string,
        platform
      );
      return { text: result };
    },
  },
  {
    tool: {
      name: "permission_reset",
      description: "Reset all permissions for an app. Android: resets runtime permissions. iOS: resets all privacy settings",
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
      const result = ctx.deviceManager.resetPermissions(
        args.package as string,
        platform
      );
      return { text: result };
    },
  },
];
