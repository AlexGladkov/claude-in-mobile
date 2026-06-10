import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { HuaweiAppGalleryClient } from "../store/huawei.js";
import { validatePackageName, validatePath } from "../utils/sanitize.js";
import { ValidationError } from "../errors.js";
import { createLazySingleton } from "../utils/lazy.js";
import { textResult } from "../utils/tool-result.js";

const client = createLazySingleton(() => new HuaweiAppGalleryClient());

export const huaweiTools: ToolDefinition[] = [
  defineTool({
    name: "huawei_upload",
    description: "Upload APK/AAB to Huawei AppGallery. Requires HUAWEI_CLIENT_ID env.",
    schema: z.object({
      packageName: z.string().describe("App package name (e.g., com.example.app)"),
      filePath: z.string().describe("Absolute path to .aab or .apk file"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      validatePath(args.filePath, "filePath");
      const result = await client().upload(args.packageName, args.filePath);
      return textResult(
        `Uploaded to Huawei AppGallery. File ID: ${result.versionId}\n` +
          `Draft is open — call huawei_set_notes and huawei_submit to publish.`,
      );
    },
  }),

  defineTool({
    name: "huawei_set_notes",
    description: "Set release notes for Huawei AppGallery draft",
    schema: z.object({
      packageName: z.string().describe("App package name"),
      language: z.string().describe("BCP-47 language tag (e.g., en-US, ru-RU, zh-CN)"),
      text: z.string().describe("Release notes text (max 500 characters)"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      if (args.text.length > 500) {
        throw new ValidationError(`Release notes exceed 500 characters (${args.text.length}).`);
      }
      await client().setReleaseNotes(args.packageName, args.language, args.text);
      return textResult(
        `Huawei release notes set for ${args.language} (${args.text.length}/500 chars)`,
      );
    },
  }),

  defineTool({
    name: "huawei_submit",
    description: "Submit Huawei AppGallery draft for review",
    schema: z.object({
      packageName: z.string().describe("App package name"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      await client().submit(args.packageName);
      return textResult(`Submitted to Huawei AppGallery for review: ${args.packageName}`);
    },
  }),

  defineTool({
    name: "huawei_get_releases",
    description: "Get release info from Huawei AppGallery",
    schema: z.object({
      packageName: z.string().describe("App package name"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      const result = await client().getReleases(args.packageName);
      return textResult(result);
    },
  }),
];
