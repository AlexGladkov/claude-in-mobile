import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { RuStoreClient } from "../store/rustore.js";
import { validatePackageName, validatePath } from "../utils/sanitize.js";
import { ValidationError } from "../errors.js";
import { createLazySingleton } from "../utils/lazy.js";
import { textResult } from "../utils/tool-result.js";

const client = createLazySingleton(() => new RuStoreClient());

export const ruStoreTools: ToolDefinition[] = [
  defineTool({
    name: "rustore_upload",
    description: "Upload APK/AAB to RuStore. Requires RUSTORE_KEY_JSON env.",
    schema: z.object({
      packageName: z.string().describe("App package name (e.g., com.example.app)"),
      filePath: z.string().describe("Absolute path to .aab or .apk file"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      validatePath(args.filePath, "filePath");
      const result = await client().upload(args.packageName, args.filePath);
      return textResult(
        `Uploaded to RuStore. Version ID: ${result.versionId}\n` +
          `Draft is open — call rustore_set_notes and rustore_submit to send for moderation.`,
      );
    },
  }),

  defineTool({
    name: "rustore_set_notes",
    description: "Set what's new for RuStore draft",
    schema: z.object({
      packageName: z.string().describe("App package name"),
      language: z.string().describe("BCP-47 language tag (e.g., ru-RU, en-US)"),
      text: z.string().describe("What's new text (max 500 characters)"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      if (args.text.length > 500) {
        throw new ValidationError(`What's new text exceeds 500 characters (${args.text.length}).`);
      }
      await client().setReleaseNotes(args.packageName, args.language, args.text);
      return textResult(`RuStore what's new set for ${args.language} (${args.text.length}/500 chars)`);
    },
  }),

  defineTool({
    name: "rustore_submit",
    description: "Submit RuStore draft for moderation",
    schema: z.object({
      packageName: z.string().describe("App package name"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      await client().submit(args.packageName);
      return textResult(
        `Submitted to RuStore for moderation: ${args.packageName}\n` +
          `Publication requires moderation approval (typically 1–3 business days).`,
      );
    },
  }),

  defineTool({
    name: "rustore_get_versions",
    description: "Get version list from RuStore",
    schema: z.object({
      packageName: z.string().describe("App package name"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      const result = await client().getReleases(args.packageName);
      return textResult(result);
    },
  }),

  defineTool({
    name: "rustore_discard",
    description: "Delete RuStore version draft",
    schema: z.object({
      packageName: z.string().describe("App package name"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      await client().discard!(args.packageName);
      return textResult(`RuStore draft deleted for ${args.packageName}`);
    },
  }),
];
