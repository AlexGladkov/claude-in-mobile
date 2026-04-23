import type { ToolDefinition } from "./registry.js";
import { GooglePlayClient } from "../store/google-play.js";
import { validatePackageName, validatePath } from "../utils/sanitize.js";
import { ValidationError } from "../errors.js";
import { createLazySingleton } from "../utils/lazy.js";

const client = createLazySingleton(() => new GooglePlayClient());

export const storeTools: ToolDefinition[] = [
  {
    tool: {
      name: "store_upload",
      description: "Upload APK/AAB to Google Play. Requires GOOGLE_PLAY_KEY_FILE env.",
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
      const result = await client().upload(args.packageName as string, args.filePath as string);
      return { text: `Uploaded. Version code: ${result.versionCode}\nDraft is open — call store_set_notes and store_submit to publish.` };
    },
  },
  {
    tool: {
      name: "store_set_notes",
      description: "Set release notes for Google Play draft (per language, max 500 chars)",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name" },
          language: { type: "string", description: "BCP-47 language tag (e.g., en-US, ru-RU)" },
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
      await client().setReleaseNotes(args.packageName as string, args.language as string, text);
      return { text: `Release notes set for ${args.language} (${text.length}/500 chars)` };
    },
  },
  {
    tool: {
      name: "store_submit",
      description: "Publish release draft to Google Play track",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name" },
          track: {
            type: "string",
            enum: ["internal", "alpha", "beta", "production"],
            description: "Release track. Use 'internal' for internal testing, 'production' for full release.",
          },
          rollout: {
            type: "number",
            description: "Staged rollout percentage 0.01–1.0 (default: 1.0 = 100%). Use < 1.0 for gradual rollout.",
            default: 1.0,
          },
        },
        required: ["packageName", "track"],
      },
    },
    handler: async (args) => {
      validatePackageName(args.packageName as string);
      const rollout = Math.min(1.0, Math.max(0.01, (args.rollout as number) ?? 1.0));
      await client().submit(args.packageName as string, args.track as string, rollout);
      const pct = rollout === 1.0 ? "100%" : `${(rollout * 100).toFixed(0)}%`;
      return { text: `Published to ${args.track} track (${pct} rollout)` };
    },
  },
  {
    tool: {
      name: "store_promote",
      description: "Promote release between Google Play tracks",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name" },
          fromTrack: {
            type: "string",
            enum: ["internal", "alpha", "beta"],
            description: "Source track to promote from",
          },
          toTrack: {
            type: "string",
            enum: ["alpha", "beta", "production"],
            description: "Target track to promote to",
          },
        },
        required: ["packageName", "fromTrack", "toTrack"],
      },
    },
    handler: async (args) => {
      validatePackageName(args.packageName as string);
      await client().promote(args.packageName as string, args.fromTrack as string, args.toTrack as string);
      return { text: `Promoted latest release: ${args.fromTrack} → ${args.toTrack}` };
    },
  },
  {
    tool: {
      name: "store_get_releases",
      description: "Get current releases across Google Play tracks",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name" },
          track: {
            type: "string",
            enum: ["internal", "alpha", "beta", "production"],
            description: "Filter by specific track. Omit to show all tracks.",
          },
        },
        required: ["packageName"],
      },
    },
    handler: async (args) => {
      validatePackageName(args.packageName as string);
      const result = await client().getReleases(
        args.packageName as string,
        args.track as string | undefined
      );
      return { text: result };
    },
  },
  {
    tool: {
      name: "store_halt_rollout",
      description: "Halt staged rollout on Google Play",
      inputSchema: {
        type: "object",
        properties: {
          packageName: { type: "string", description: "App package name" },
          track: {
            type: "string",
            enum: ["alpha", "beta", "production"],
            description: "Track with the active staged rollout",
          },
        },
        required: ["packageName", "track"],
      },
    },
    handler: async (args) => {
      validatePackageName(args.packageName as string);
      await client().haltRollout(args.packageName as string, args.track as string);
      return { text: `Rollout halted on ${args.track} track` };
    },
  },
  {
    tool: {
      name: "store_discard",
      description: "Discard Google Play release draft",
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
      await client().discard(args.packageName as string);
      return { text: `Release draft discarded for ${args.packageName}` };
    },
  },
];
