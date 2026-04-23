import type { ToolDefinition } from "./registry.js";
import { RuStoreClient } from "../store/rustore.js";
import { validatePackageName, validatePath } from "../utils/sanitize.js";
import { ValidationError } from "../errors.js";
import { createLazySingleton } from "../utils/lazy.js";

const client = createLazySingleton(() => new RuStoreClient());

export const ruStoreTools: ToolDefinition[] = [
  {
    tool: {
      name: "rustore_upload",
      description: "Upload APK/AAB to RuStore. Requires RUSTORE_KEY_JSON env.",
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
          `Uploaded to RuStore. Version ID: ${result.versionId}\n` +
          `Draft is open — call rustore_set_notes and rustore_submit to send for moderation.`,
      };
    },
  },
  {
    tool: {
      name: "rustore_set_notes",
      description: "Set what's new for RuStore draft",
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
      validatePackageName(args.packageName as string);
      const text = args.text as string;
      if (text.length > 500) {
        throw new ValidationError(`What's new text exceeds 500 characters (${text.length}).`);
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
      description: "Submit RuStore draft for moderation",
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
      description: "Get version list from RuStore",
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
  {
    tool: {
      name: "rustore_discard",
      description: "Delete RuStore version draft",
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
      await client().discard!(args.packageName as string);
      return { text: `RuStore draft deleted for ${args.packageName}` };
    },
  },
];
