import { createMetaTool } from "./create-meta-tool.js";
import { screenshotTools } from "../screenshot-tools.js";

const { meta, aliases } = createMetaTool({
  name: "screen",
  description:
    "Screen capture and annotation. capture: screenshot with compression/diff. annotate: screenshot with element bounding boxes.",
  tools: screenshotTools,
  prefix: "screen_",
  extraSchema: {
    platform: {
      type: "string",
      enum: ["android", "ios", "desktop", "aurora", "browser"],
      description: "Target platform. If not specified, uses the active target.",
    },
    preset: { type: "string", enum: ["low", "medium", "high"], description: "Quality preset: low (270x480 q40), medium (540x960 q55, default), high (810x1440 q70)" },
    compress: { type: "boolean", description: "Compress image (default: true)", default: true },
    maxWidth: { type: "number", description: "Max width in pixels (default: 540)", default: 540 },
    maxHeight: { type: "number", description: "Max height in pixels (default: 960)", default: 960 },
    quality: { type: "number", description: "JPEG quality 1-100 (default: 55)", default: 55 },
    monitorIndex: { type: "number", description: "Monitor index for multi-monitor desktop setups" },
    diff: { type: "boolean", description: "Compare with previous screenshot (capture only)", default: false },
    diffThreshold: { type: "number", description: "Pixel difference threshold 0-255 (default: 30)", default: 30 },
    waitForStable: {
      type: "boolean",
      description: "Wait for UI to stabilize before capturing (capture only)",
      default: false,
    },
  },
});

export const screenMeta = meta;
export const screenAliases = aliases;
