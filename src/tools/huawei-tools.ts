import type { ToolDefinition } from "./registry.js";
import { HuaweiAppGalleryClient } from "../store/huawei.js";
import { validatePackageName, validatePath } from "../utils/sanitize.js";
import { ValidationError } from "../errors.js";
import { createLazySingleton } from "../utils/lazy.js";

const client = createLazySingleton(() => new HuaweiAppGalleryClient());

export const huaweiTools: ToolDefinition[] = [
  {
    tool: {
      name: "huawei_upload",
      description: "Upload APK/AAB to Huawei AppGallery. Requires HUAWEI_CLIENT_ID env.",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name (e.g., com.example.app)" },
          filePath: { type: "string", description: "Absolute path to .aab or .apk file" },
        },
        required: ["packageName", "filePath"],
      },
    },
    handler: async (args) => {
      validatePackageName(args.packageName as string);
      validatePath(args.filePath as string, "filePath");
      const result = await client().upload(
        args.packageName as string,
        args.filePath as string
      );
      return {
        text:
          `Uploaded to Huawei AppGallery. File ID: ${result.versionId}\n` +
          `Draft is open — call huawei_set_notes and huawei_submit to publish.`,
      };
    },
  },
  {
    tool: {
      name: "huawei_set_notes",
      description: "Set release notes for Huawei AppGallery draft",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name" },
          language: {
            type: "string",
            description: "BCP-47 language tag (e.g., en-US, ru-RU, zh-CN)",
          },
          text: { type: "string", description: "Release notes text (max 500 characters)" },
        },
        required: ["packageName", "language", "text"],
      },
    },
    handler: async (args) => {
      validatePackageName(args.packageName as string);
      const text = args.text as string;
      if (text.length > 500) {
        throw new ValidationError(`Release notes exceed 500 characters (${text.length}).`);
      }
      await client().setReleaseNotes(
        args.packageName as string,
        args.language as string,
        text
      );
      return { text: `Huawei release notes set for ${args.language} (${text.length}/500 chars)` };
    },
  },
  {
    tool: {
      name: "huawei_submit",
      description: "Submit Huawei AppGallery draft for review",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name" },
        },
        required: ["packageName"],
      },
    },
    handler: async (args) => {
      validatePackageName(args.packageName as string);
      await client().submit(args.packageName as string);
      return { text: `Submitted to Huawei AppGallery for review: ${args.packageName}` };
    },
  },
  {
    tool: {
      name: "huawei_get_releases",
      description: "Get release info from Huawei AppGallery",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name" },
        },
        required: ["packageName"],
      },
    },
    handler: async (args) => {
      validatePackageName(args.packageName as string);
      const result = await client().getReleases(args.packageName as string);
      return { text: result };
    },
  },
];
