import { createMetaTool } from "./create-meta-tool.js";
import { desktopTools } from "../desktop-tools.js";

const { meta, aliases: generatedAliases } = createMetaTool({
  name: "desktop",
  description:
    "Desktop app management: launch, stop, windows, focus, resize, clipboard, performance, monitors",
  tools: desktopTools,
  prefix: "desktop_",
  extraSchema: {
    projectPath: { type: "string", description: "Path to Gradle project directory (launch)" },
    task: { type: "string", description: "Gradle task to run (launch)" },
    jvmArgs: { type: "array", items: { type: "string" }, description: "JVM arguments (launch)" },
    bundleId: { type: "string", description: "macOS bundle ID, e.g. 'com.apple.TextEdit' (launch)" },
    appPath: { type: "string", description: "Path to .app bundle (launch)" },
    pid: { type: "number", description: "Attach to running process by PID (launch)" },
    windowId: { type: "string", description: "Window ID (focus, resize)" },
    width: { type: "number", description: "New window width in pixels (resize)" },
    height: { type: "number", description: "New window height in pixels (resize)" },
    text: { type: "string", description: "Text to set in clipboard (clipboard_set)" },
  },
});

export const desktopMeta = meta;

// Desktop aliases need some manual overrides because clipboard tools
// don't follow the "desktop_" prefix convention (clipboard_get, clipboard_set)
export const desktopAliases: Record<string, { tool: string; defaults: Record<string, unknown> }> = {
  ...generatedAliases,
  // Override clipboard aliases: the original tool names are clipboard_get/clipboard_set
  // but create-meta-tool already maps them correctly since prefix "desktop_" doesn't
  // match "clipboard_" — they stay as-is in the alias map.
};
