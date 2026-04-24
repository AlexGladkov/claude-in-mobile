import { createMetaTool } from "./create-meta-tool.js";
import { recorderTools } from "../recorder-tools.js";

const { meta, aliases } = createMetaTool({
  name: "recorder",
  description:
    "Test scenario recorder. start: begin recording. stop: save scenario. status: check state. add_step: manual step. remove_step: delete step. list: saved scenarios. show: display scenario. delete: remove. play: replay. export: convert format.",
  tools: recorderTools,
  prefix: "recorder_",
  extraSchema: {
    platform: {
      type: "string",
      enum: ["android", "ios", "desktop", "aurora", "browser"],
      description: "Target platform. If not specified, uses the active target.",
    },
    name: { type: "string", description: "Scenario name (e.g. 'login-flow', 'checkout')" },
    tags: { type: "array", items: { type: "string" }, description: "Tags for categorizing scenarios" },
    tag: { type: "string", description: "Filter by tag (list)" },
    description: { type: "string", description: "Scenario description" },
    overwrite: { type: "boolean", description: "Overwrite existing scenario (default: false)", default: false },
    discard: { type: "boolean", description: "Discard recording without saving (stop)", default: false },
    speed: { type: "number", description: "Playback speed multiplier (default: 1.0)", default: 1.0 },
    stopOnFail: { type: "boolean", description: "Stop on first failure (default: true)", default: true },
    stepTimeout: { type: "number", description: "Per-step timeout ms (default: 5000)", default: 5000 },
    maxDuration: { type: "number", description: "Max total playback ms (default: 60000)", default: 60000 },
    fromStep: { type: "number", description: "Start from step index (play)" },
    toStep: { type: "number", description: "End at step index (play)" },
    dryRun: { type: "boolean", description: "Log steps without executing (play)", default: false },
    stepIndex: { type: "number", description: "Step index (remove_step, 1-based)" },
    format: { type: "string", enum: ["flow_steps", "markdown"], description: "Export format" },
    action_name: { type: "string", description: "Tool action name (add_step)" },
    args: { type: "object", description: "Step arguments (add_step)" },
    label: { type: "string", description: "Step label (add_step)" },
  },
});

export const recorderMeta = meta;
export const recorderAliases = aliases;
