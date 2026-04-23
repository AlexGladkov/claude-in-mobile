import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { validatePackageName, validatePermission } from "../utils/sanitize.js";

export const permissionTools: ToolDefinition[] = [
  {
    tool: {
      name: "permission_grant",
      description: "Grant app permission (Android runtime / iOS privacy)",
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
      validatePackageName(args.package as string);
      validatePermission(args.permission as string);
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
      description: "Revoke app permission",
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
      validatePackageName(args.package as string);
      validatePermission(args.permission as string);
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
      description: "Reset all permissions for an app",
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
      validatePackageName(args.package as string);
      const result = ctx.deviceManager.resetPermissions(
        args.package as string,
        platform
      );
      return { text: result };
    },
  },
];
