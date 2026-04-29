import { createMetaTool } from "./create-meta-tool.js";
import { uiTools } from "../ui-tools.js";

const { meta, aliases } = createMetaTool({
  name: "ui",
  description:
    "UI inspection and interaction. tree: accessibility tree. find: search elements. find_tap: fuzzy tap (Android). tap_text: tap by text (Desktop). analyze: screen analysis. wait/assert_visible/assert_gone: element checks.",
  tools: uiTools,
  prefix: "ui_",
  extraSchema: {
    text: { type: "string", description: "Element text to search/check (partial match, case-insensitive)" },
    label: { type: "string", description: "iOS: Find by accessibility label" },
    resourceId: { type: "string", description: "Android: Find by resource ID (partial match)" },
    className: { type: "string", description: "Find by class name" },
    clickable: { type: "boolean", description: "Android: Filter by clickable state" },
    visible: { type: "boolean", description: "iOS: Filter by visibility" },
    showAll: { type: "boolean", description: "Show all elements including non-interactive (tree only)", default: false },
    compact: { type: "boolean", description: "Compact output: only interactive elements, short format (tree only)", default: false },
    format: {
      type: "string",
      enum: ["default", "compact", "semantic"],
      description: "Output format. semantic = grouped by role, minimal tokens",
    },
    description: { type: "string", description: "Natural language description of element to tap (find_tap only)" },
    minConfidence: { type: "number", description: "Minimum confidence score 0-100 for find_tap (default: 30)", default: 30 },
    pid: { type: "number", description: "Process ID of target application (tap_text only)" },
    exactMatch: { type: "boolean", description: "Require exact text match for tap_text (default: false)", default: false },
    fresh: { type: "boolean", description: "Force bypass cache and fetch live UI tree", default: false },
    timeout: { type: "number", description: "Max wait time in ms for wait (default: 5000)", default: 5000 },
    interval: { type: "number", description: "Poll interval in ms for wait (default: 500)", default: 500 },
    platform: {
      type: "string",
      enum: ["android", "ios", "desktop", "aurora", "browser"],
      description: "Target platform. If not specified, uses the active target.",
    },
  },
});

export const uiMeta = meta;
export const uiAliases = aliases;
