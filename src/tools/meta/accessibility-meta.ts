import { createMetaTool } from "./create-meta-tool.js";
import { accessibilityTools } from "../accessibility-tools.js";

const { meta, aliases } = createMetaTool({
  name: "accessibility",
  description:
    "Accessibility Guardian. audit: full WCAG audit of current screen. check: audit a single element. summary: quick score + counts. rules: list available rules.",
  tools: accessibilityTools,
  prefix: "accessibility_",
  extraSchema: {
    platform: {
      type: "string",
      enum: ["android", "ios", "desktop"],
      description: "Target platform. If not specified, uses the active target.",
    },
    standard: {
      type: "string",
      enum: ["A", "AA", "AAA"],
      description: "WCAG conformance level (default: AA)",
    },
    severity: {
      type: "string",
      enum: ["critical", "serious", "moderate", "minor"],
      description: "Filter issues by severity (audit only)",
    },
    compact: {
      type: "boolean",
      description: "Compact output: one line per issue (default: false)",
    },
    text: {
      type: "string",
      description: "Find element by text content (check only)",
    },
    resourceId: {
      type: "string",
      description: "Find element by resource ID (check only)",
    },
    index: {
      type: "number",
      description: "Find element by index (check only)",
    },
    ruleId: {
      type: "string",
      description: "Specific rule ID (rules only)",
    },
  },
});

export const accessibilityMeta = meta;
export const accessibilityAliases = aliases;
