import { createMetaTool } from "./create-meta-tool.js";
import { sandboxTools } from "../sandbox-tools.js";

const { meta, aliases } = createMetaTool({
  name: "sandbox",
  description:
    "App Sandbox Access. " +
    "prefs_read: read SharedPreferences XML from the app sandbox. " +
    "prefs_write: write/update a single SharedPreferences value. " +
    "sqlite_query: run a read-only SQL SELECT/PRAGMA on an app database. " +
    "file_list: list files and directories inside the sandbox. " +
    "file_read: read a text file from the sandbox. " +
    "All operations use adb run-as and require a debuggable app or userdebug/eng build.",
  tools: sandboxTools,
  prefix: "sandbox_",
  extraSchema: {
    package: {
      type: "string",
      description: "App package name (e.g. com.example.app). Required for all actions.",
    },
    platform: {
      type: "string",
      enum: ["android"],
      description: "Target platform. Sandbox access is Android-only.",
    },
  },
});

export const sandboxMeta = meta;
export const sandboxAliases = aliases;
