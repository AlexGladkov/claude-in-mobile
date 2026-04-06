import type { ToolDefinition } from "./registry.js";
import { HuaweiAppGalleryClient } from "../store/huawei.js";

let _client: HuaweiAppGalleryClient | null = null;

function client(): HuaweiAppGalleryClient {
  if (!_client) _client = new HuaweiAppGalleryClient();
  return _client;
}

export const huaweiTools: ToolDefinition[] = [
  {
    tool: {
      name: "huawei_upload",
      description:
        "Upload APK or AAB to Huawei AppGallery Connect. Creates a release draft. Returns the fileId. " +
        "Requires HUAWEI_CLIENT_ID and HUAWEI_CLIENT_SECRET environment variables.",
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
      description:
        "Set release notes (what's new) for the current Huawei AppGallery draft. " +
        "Call once per language. Max 500 characters.",
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
      const text = args.text as string;
      if (text.length > 500) {
        return { text: `Error: release notes exceed 500 characters (${text.length})` };
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
      description:
        "Submit the current Huawei AppGallery draft for review and publishing. " +
        "Commits the upload and triggers the AppGallery review process.",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name" },
        },
        required: ["packageName"],
      },
    },
    handler: async (args) => {
      await client().submit(args.packageName as string);
      return { text: `Submitted to Huawei AppGallery for review: ${args.packageName}` };
    },
  },
  {
    tool: {
      name: "huawei_get_releases",
      description: "Get current release information for an app in Huawei AppGallery Connect.",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name" },
        },
        required: ["packageName"],
      },
    },
    handler: async (args) => {
      const result = await client().getReleases(args.packageName as string);
      return { text: result };
    },
  },
];
