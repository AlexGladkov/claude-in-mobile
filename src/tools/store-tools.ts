import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { GooglePlayClient } from "../store/google-play.js";
import { validatePackageName, validatePath } from "../utils/sanitize.js";
import { ValidationError } from "../errors.js";
import { createLazySingleton } from "../utils/lazy.js";
import { textResult } from "../utils/tool-result.js";

const client = createLazySingleton(() => new GooglePlayClient());

export const storeTools: ToolDefinition[] = [
  defineTool({
    name: "store_upload",
    description: "Upload APK/AAB to Google Play. Requires GOOGLE_PLAY_KEY_FILE env.",
    schema: z.object({
      packageName: z.string().describe("App package name (e.g., com.example.app)"),
      filePath: z.string().describe("Absolute path to .aab or .apk file"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      validatePath(args.filePath, "filePath");
      const result = await client().upload(args.packageName, args.filePath);
      return textResult(
        `Uploaded. Version code: ${result.versionCode}\nDraft is open — call store_set_notes and store_submit to publish.`,
      );
    },
  }),

  defineTool({
    name: "store_set_notes",
    description: "Set release notes for Google Play draft (per language, max 500 chars)",
    schema: z.object({
      packageName: z.string().describe("App package name"),
      language: z.string().describe("BCP-47 language tag (e.g., en-US, ru-RU)"),
      text: z.string().describe("Release notes text (max 500 characters)"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      if (args.text.length > 500) {
        throw new ValidationError(`Release notes exceed 500 characters (${args.text.length}).`);
      }
      await client().setReleaseNotes(args.packageName, args.language, args.text);
      return textResult(`Release notes set for ${args.language} (${args.text.length}/500 chars)`);
    },
  }),

  defineTool({
    name: "store_submit",
    description: "Publish release draft to Google Play track",
    schema: z.object({
      packageName: z.string().describe("App package name"),
      track: z
        .enum(["internal", "alpha", "beta", "production"])
        .describe("Release track. Use 'internal' for internal testing, 'production' for full release."),
      rollout: z
        .number()
        .default(1.0)
        .describe("Staged rollout percentage 0.01–1.0 (default: 1.0 = 100%). Use < 1.0 for gradual rollout."),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      const rollout = Math.min(1.0, Math.max(0.01, args.rollout ?? 1.0));
      await client().submit(args.packageName, args.track, rollout);
      const pct = rollout === 1.0 ? "100%" : `${(rollout * 100).toFixed(0)}%`;
      return textResult(`Published to ${args.track} track (${pct} rollout)`);
    },
  }),

  defineTool({
    name: "store_promote",
    description: "Promote release between Google Play tracks",
    schema: z.object({
      packageName: z.string().describe("App package name"),
      fromTrack: z.enum(["internal", "alpha", "beta"]).describe("Source track to promote from"),
      toTrack: z.enum(["alpha", "beta", "production"]).describe("Target track to promote to"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      await client().promote(args.packageName, args.fromTrack, args.toTrack);
      return textResult(`Promoted latest release: ${args.fromTrack} → ${args.toTrack}`);
    },
  }),

  defineTool({
    name: "store_get_releases",
    description: "Get current releases across Google Play tracks",
    schema: z.object({
      packageName: z.string().describe("App package name"),
      track: z
        .enum(["internal", "alpha", "beta", "production"])
        .optional()
        .describe("Filter by specific track. Omit to show all tracks."),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      const result = await client().getReleases(args.packageName, args.track);
      return textResult(result);
    },
  }),

  defineTool({
    name: "store_halt_rollout",
    description: "Halt staged rollout on Google Play",
    schema: z.object({
      packageName: z.string().describe("App package name"),
      track: z.enum(["alpha", "beta", "production"]).describe("Track with the active staged rollout"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      await client().haltRollout(args.packageName, args.track);
      return textResult(`Rollout halted on ${args.track} track`);
    },
  }),

  defineTool({
    name: "store_discard",
    description: "Discard Google Play release draft",
    schema: z.object({
      packageName: z.string().describe("App package name"),
    }),
    handler: async (args) => {
      validatePackageName(args.packageName);
      await client().discard(args.packageName);
      return textResult(`Release draft discarded for ${args.packageName}`);
    },
  }),
];
