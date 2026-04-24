import { createMetaTool } from "./create-meta-tool.js";
import { visualTools } from "../visual-tools.js";

const { meta, aliases } = createMetaTool({
  name: "visual",
  description:
    "Visual regression testing. baseline_save: capture baseline screenshot. compare: diff against baseline. baseline_update: overwrite baseline. list: show all baselines. delete: remove baseline. suite: batch comparison.",
  tools: visualTools,
  prefix: "visual_",
  extraSchema: {
    platform: {
      type: "string",
      enum: ["android", "ios", "desktop", "aurora", "browser"],
      description: "Target platform. If not specified, uses the active target.",
    },
    name: { type: "string", description: "Baseline name (e.g. 'login-screen', 'dashboard')" },
    tags: { type: "array", items: { type: "string" }, description: "Tags for categorizing baselines" },
    tag: { type: "string", description: "Filter by tag (list, suite)" },
    threshold: { type: "number", description: "Max allowed change % (default: 1.0)", default: 1.0 },
    diffThreshold: { type: "number", description: "Pixel sensitivity 0-255 (default: 30)", default: 30 },
    ignoreRegions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          x: { type: "number" }, y: { type: "number" },
          width: { type: "number" }, height: { type: "number" },
        },
        required: ["x", "y", "width", "height"],
      },
      description: "Screen regions to exclude from comparison (e.g. status bar, clock)",
    },
    overwrite: { type: "boolean", description: "Overwrite existing baseline (default: false)", default: false },
    reason: { type: "string", description: "Reason for baseline update (recorded in metadata)" },
    waitForStable: { type: "boolean", description: "Wait for UI stabilization (default: true)", default: true },
    stopOnFail: { type: "boolean", description: "Stop suite on first failure (default: false)", default: false },
  },
});

export const visualMeta = meta;
export const visualAliases = aliases;
