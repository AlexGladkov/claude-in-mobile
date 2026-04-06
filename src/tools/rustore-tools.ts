import type { ToolDefinition } from "./registry.js";
import { RuStoreClient } from "../store/rustore.js";

let _client: RuStoreClient | null = null;

function client(): RuStoreClient {
  if (!_client) _client = new RuStoreClient();
  return _client;
}

export const ruStoreTools: ToolDefinition[] = [
  {
    tool: {
      name: "rustore_upload",
      description:
        "Upload APK or AAB to RuStore. Automatically creates a new version draft and uploads the file. " +
        "Requires RUSTORE_KEY_JSON (JSON with companyId, keyId, privateKey) or " +
        "RUSTORE_COMPANY_ID + RUSTORE_KEY_ID + RUSTORE_PRIVATE_KEY environment variables.",
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
          `Uploaded to RuStore. Version ID: ${result.versionId}\n` +
          `Draft is open — call rustore_set_notes and rustore_submit to send for moderation.`,
      };
    },
  },
  {
    tool: {
      name: "rustore_set_notes",
      description:
        "Set what's new notes for the current RuStore version draft. " +
        "Call once per language. Max 500 characters.",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name" },
          language: {
            type: "string",
            description: "BCP-47 language tag (e.g., ru-RU, en-US)",
          },
          text: { type: "string", description: "What's new text (max 500 characters)" },
        },
        required: ["packageName", "language", "text"],
      },
    },
    handler: async (args) => {
      const text = args.text as string;
      if (text.length > 500) {
        return { text: `Error: what's new text exceeds 500 characters (${text.length})` };
      }
      await client().setReleaseNotes(
        args.packageName as string,
        args.language as string,
        text
      );
      return { text: `RuStore what's new set for ${args.language} (${text.length}/500 chars)` };
    },
  },
  {
    tool: {
      name: "rustore_submit",
      description:
        "Send the current RuStore version draft for moderation. " +
        "Note: publication is not immediate — it requires passing the RuStore moderation process, " +
        "which may take 1–3 business days.",
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
      return {
        text:
          `Submitted to RuStore for moderation: ${args.packageName}\n` +
          `Publication requires moderation approval (typically 1–3 business days).`,
      };
    },
  },
  {
    tool: {
      name: "rustore_get_versions",
      description: "Get list of versions and their statuses for an app in RuStore.",
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
  {
    tool: {
      name: "rustore_discard",
      description:
        "Delete the current RuStore version draft without submitting. " +
        "Use to cancel an upload and start over.",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name" },
        },
        required: ["packageName"],
      },
    },
    handler: async (args) => {
      await client().discard!(args.packageName as string);
      return { text: `RuStore draft deleted for ${args.packageName}` };
    },
  },
];
