import { createMetaTool } from "./create-meta-tool.js";
import { autopilotTools } from "../autopilot-tools.js";

const { meta, aliases } = createMetaTool({
  name: "autopilot",
  description:
    "AI Test Autopilot. explore: auto-navigate app and build navigation graph. generate: create test scenarios from exploration. heal: self-heal broken test selectors. status: exploration status. tests: list/get generated tests.",
  tools: autopilotTools,
  prefix: "autopilot_",
  extraSchema: {
    platform: {
      type: "string",
      enum: ["android", "ios", "desktop"],
      description: "Target platform. If not specified, uses the active target.",
    },
    package: {
      type: "string",
      description: "App package name (explore only)",
    },
    strategy: {
      type: "string",
      enum: ["bfs", "dfs", "smart"],
      description: "Exploration strategy (explore only, default: smart)",
    },
    maxScreens: {
      type: "number",
      description: "Max screens to discover (explore only, default: 20)",
    },
    maxActions: {
      type: "number",
      description: "Max actions to perform (explore only, default: 100)",
    },
    dryRun: {
      type: "boolean",
      description: "Analyze without performing actions (explore only)",
    },
    explorationId: {
      type: "string",
      description: "Exploration ID (generate/status/tests)",
    },
    format: {
      type: "string",
      enum: ["flow_run", "steps"],
      description: "Test output format (generate only, default: flow_run)",
    },
    originalSelector: {
      type: "object",
      description: "Original selector for healing (heal only)",
    },
    confidence: {
      type: "number",
      description: "Min confidence threshold 0-1 (heal only, default: 0.6)",
    },
    testId: {
      type: "string",
      description: "Specific test ID (tests only)",
    },
  },
});

export const autopilotMeta = meta;
export const autopilotAliases = aliases;
