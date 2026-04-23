import { createMetaTool } from "./create-meta-tool.js";
import { appTools } from "../app-tools.js";
import type { ToolDefinition } from "../registry.js";

/**
 * Meta tool for app lifecycle: launch, stop, install, list.
 *
 * Naming note: app tools use `package` (short form for package identifier),
 * while store tools use `packageName` (Android convention). Both refer to
 * the same concept -- the app's package name / bundle ID.
 *
 * This meta tool accepts both `package` and `packageName`. If `packageName`
 * is provided but `package` is not, it is automatically mapped to `package`.
 */
const { meta: rawMeta, aliases } = createMetaTool({
  name: "app",
  description: "App lifecycle: launch, stop, install, list",
  tools: appTools,
  prefix: "app_",
  extraSchema: {
    packageName: {
      type: "string",
      description: "Alias for 'package'. App package name (Android) or bundle ID (iOS). Either 'package' or 'packageName' can be used.",
    },
  },
});

// Wrap handler to normalize packageName -> package
const originalHandler = rawMeta.handler;
export const appMeta: ToolDefinition = {
  ...rawMeta,
  handler: async (args, ctx, depth) => {
    // Accept packageName as an alias for package
    if (args.packageName && !args.package) {
      args.package = args.packageName;
    }
    return originalHandler(args, ctx, depth);
  },
};

export const appAliases = aliases;
