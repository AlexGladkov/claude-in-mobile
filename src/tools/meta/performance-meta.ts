import { createMetaTool } from "./create-meta-tool.js";
import { performanceTools } from "../performance-tools.js";

const { meta, aliases } = createMetaTool({
  name: "performance",
  description:
    "Performance & Crash Monitor. snapshot: collect current metrics. baseline: save metrics for comparison. compare: PASS/FAIL against baseline. monitor: continuous sampling over duration. crashes: query crash/ANR logs.",
  tools: performanceTools,
  prefix: "performance_",
  extraSchema: {
    platform: {
      type: "string",
      enum: ["android", "ios", "desktop"],
      description: "Target platform. If not specified, uses the active target.",
    },
    packageName: {
      type: "string",
      description: "App package name (Android). Auto-detected from foreground if not provided.",
    },
    name: {
      type: "string",
      description: "Baseline name (baseline/compare only)",
    },
    overwrite: {
      type: "boolean",
      description: "Overwrite existing baseline (default: false)",
    },
    samples: {
      type: "number",
      description: "Number of samples to average for baseline (default: 3)",
    },
    memoryThreshold: {
      type: "number",
      description: "Max allowed memory change % (compare only, default: 20)",
    },
    cpuThreshold: {
      type: "number",
      description: "Max allowed CPU change % (compare only, default: 30)",
    },
    fpsThreshold: {
      type: "number",
      description: "Max allowed FPS drop % (compare only, default: 10)",
    },
    duration: {
      type: "number",
      description: "Monitoring duration in ms (monitor only, default: 5000)",
    },
    interval: {
      type: "number",
      description: "Sampling interval in ms (monitor only, default: 1000)",
    },
  },
});

export const performanceMeta = meta;
export const performanceAliases = aliases;
