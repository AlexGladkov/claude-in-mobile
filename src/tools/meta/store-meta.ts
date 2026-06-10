import type { ToolDefinition } from "../registry.js";
import { storeTools } from "../store-tools.js";
import { huaweiTools } from "../huawei-tools.js";
import { ruStoreTools } from "../rustore-tools.js";
import { appStoreTools } from "../appstore-tools.js";
import { UnknownActionError } from "../../errors.js";

// Map: provider -> action -> handler
const providerHandlers = new Map<string, Map<string, ToolDefinition["handler"]>>();

const googleMap = new Map<string, ToolDefinition["handler"]>();
for (const t of storeTools) {
  googleMap.set(t.tool.name.replace(/^store_/, ""), t.handler);
}
providerHandlers.set("google", googleMap);

const huaweiMap = new Map<string, ToolDefinition["handler"]>();
for (const t of huaweiTools) {
  huaweiMap.set(t.tool.name.replace(/^huawei_/, ""), t.handler);
}
providerHandlers.set("huawei", huaweiMap);

const rustoreMap = new Map<string, ToolDefinition["handler"]>();
for (const t of ruStoreTools) {
  rustoreMap.set(t.tool.name.replace(/^rustore_/, ""), t.handler);
}
providerHandlers.set("rustore", rustoreMap);

const appleMap = new Map<string, ToolDefinition["handler"]>();
for (const t of appStoreTools) {
  appleMap.set(t.tool.name.replace(/^appstore_/, ""), t.handler);
}
providerHandlers.set("apple", appleMap);

const PROVIDERS = ["google", "huawei", "rustore", "apple"];
const ACTIONS = [
  "upload", "set_notes", "submit", "get_releases", "discard",
  "promote", "halt_rollout", "get_versions",
  "build",
];

export const storeMeta: ToolDefinition = {
  tool: {
    name: "store",
    description:
      "App store management (Google Play, Huawei, RuStore, Apple TestFlight). " +
      "Google: upload -> set_notes -> submit. " +
      "Apple (provider:'apple'): build -> upload -> get_releases (poll) -> set_notes -> promote. " +
      "Use provider param to select store.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ACTIONS,
          description: "Action to perform (build is apple-only)",
        },
        provider: {
          type: "string",
          enum: PROVIDERS,
          description: "Store provider (default: google)",
          default: "google",
        },
        packageName: { type: "string", description: "App package name (e.g., com.example.app)" },
        filePath: { type: "string", description: "Absolute path to .aab or .apk file (upload)" },
        language: { type: "string", description: "BCP-47 language tag, e.g. en-US, ru-RU (set_notes)" },
        text: { type: "string", description: "Release notes text, max 500 chars (set_notes)" },
        track: {
          type: "string",
          enum: ["internal", "alpha", "beta", "production"],
          description: "Release track (submit, get_releases, halt_rollout)",
        },
        fromTrack: {
          type: "string",
          enum: ["internal", "alpha", "beta"],
          description: "Source track (promote)",
        },
        toTrack: {
          type: "string",
          enum: ["alpha", "beta", "production"],
          description: "Target track (promote)",
        },
        rollout: {
          type: "number",
          description: "Staged rollout percentage 0.01-1.0 (submit, default: 1.0)",
          default: 1.0,
        },
        // Apple / TestFlight (provider: "apple")
        bundleId: { type: "string", description: "App bundle ID, e.g. com.example.app (apple)" },
        projectPath: { type: "string", description: "Absolute path to iOS project root (apple build)" },
        scheme: { type: "string", description: "Xcode scheme (apple build, default: auto-pick Release)" },
        configuration: { type: "string", description: "Build configuration (apple build, default: Release)" },
        ipaPath: { type: "string", description: "Absolute path to .ipa (apple upload)" },
        version: { type: "string", description: "Marketing version filter, e.g. 1.2.3 (apple get_releases)" },
        buildId: { type: "string", description: "ASC build ID — default: latest VALID build (apple set_notes/promote/submit)" },
        whatsNew: { type: "string", description: 'TestFlight "What to Test" text (apple set_notes)' },
        locale: { type: "string", description: "BCP-47 locale, default en-US (apple set_notes)" },
        groupName: { type: "string", description: "TestFlight beta group name (apple promote)" },
        submitReview: { type: "boolean", description: "Auto-submit external groups for beta review (apple promote, default: true)" },
      },
      required: ["action"],
    },
  },
  handler: async (args, ctx, depth) => {
    const action = args.action as string;
    const provider = (args.provider as string) ?? "google";
    const pMap = providerHandlers.get(provider);
    if (!pMap) throw new UnknownActionError("store", provider, PROVIDERS);
    const handler = pMap.get(action);
    if (!handler) throw new UnknownActionError("store", action, ACTIONS);
    return handler(args, ctx, depth);
  },
};

export const storeAliases: Record<string, { tool: string; defaults: Record<string, unknown> }> = {
  // Google Play
  store_upload: { tool: "store", defaults: { action: "upload", provider: "google" } },
  store_set_notes: { tool: "store", defaults: { action: "set_notes", provider: "google" } },
  store_submit: { tool: "store", defaults: { action: "submit", provider: "google" } },
  store_promote: { tool: "store", defaults: { action: "promote", provider: "google" } },
  store_get_releases: { tool: "store", defaults: { action: "get_releases", provider: "google" } },
  store_halt_rollout: { tool: "store", defaults: { action: "halt_rollout", provider: "google" } },
  store_discard: { tool: "store", defaults: { action: "discard", provider: "google" } },
  // Huawei AppGallery
  huawei_upload: { tool: "store", defaults: { action: "upload", provider: "huawei" } },
  huawei_set_notes: { tool: "store", defaults: { action: "set_notes", provider: "huawei" } },
  huawei_submit: { tool: "store", defaults: { action: "submit", provider: "huawei" } },
  huawei_get_releases: { tool: "store", defaults: { action: "get_releases", provider: "huawei" } },
  // RuStore
  rustore_upload: { tool: "store", defaults: { action: "upload", provider: "rustore" } },
  rustore_set_notes: { tool: "store", defaults: { action: "set_notes", provider: "rustore" } },
  rustore_submit: { tool: "store", defaults: { action: "submit", provider: "rustore" } },
  rustore_get_versions: { tool: "store", defaults: { action: "get_versions", provider: "rustore" } },
  rustore_discard: { tool: "store", defaults: { action: "discard", provider: "rustore" } },
  // Apple TestFlight
  testflight_build: { tool: "store", defaults: { action: "build", provider: "apple" } },
  testflight_upload: { tool: "store", defaults: { action: "upload", provider: "apple" } },
  testflight_status: { tool: "store", defaults: { action: "get_releases", provider: "apple" } },
  testflight_set_notes: { tool: "store", defaults: { action: "set_notes", provider: "apple" } },
  testflight_distribute: { tool: "store", defaults: { action: "promote", provider: "apple" } },
  testflight_submit: { tool: "store", defaults: { action: "submit", provider: "apple" } },
};
