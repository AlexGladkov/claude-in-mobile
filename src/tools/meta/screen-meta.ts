import { createMetaTool } from "./create-meta-tool.js";
import { screenshotTools } from "../screenshot-tools.js";
import { PLATFORM_JSON_SCHEMA } from "../common-schema.js";

const { meta, aliases } = createMetaTool({
  name: "screen",
  description:
    "Screen capture and annotation. capture: screenshot with compression/diff. annotate: screenshot with element bounding boxes.",
  tools: screenshotTools,
  prefix: "screen_",
  extraSchema: {
    platform: {
      ...PLATFORM_JSON_SCHEMA,
      description: "Target platform. If not specified, uses the active target.",
    },
    preset: { type: "string", enum: ["low", "medium", "high"], description: "Quality preset: low (270x480 q40), medium (540x960 q55, default), high (810x1440 q70)" },
    compress: { type: "boolean", description: "Compress image (default: true)", default: true },
    // No `default:` here on purpose: a JSON-schema default makes LLM clients
    // pre-fill these before tool_use, which shadows `preset` exactly the way a
    // zod .default() did in the handler. Leaving them absent lets `preset` win;
    // the medium fallback is applied last in the capture handler (#56).
    maxWidth: { type: "number", description: "Max width in pixels (overrides preset; default via preset or 540). Max 2000." },
    maxHeight: { type: "number", description: "Max height in pixels (overrides preset; default via preset or 960). Max 2000." },
    quality: { type: "number", description: "JPEG quality 1-100 (overrides preset; default via preset or 55)." },
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
