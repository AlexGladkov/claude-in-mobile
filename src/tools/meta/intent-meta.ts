import { createMetaTool } from "./create-meta-tool.js";
import { intentTools } from "../intent-tools.js";

const { meta, aliases } = createMetaTool({
  name: "intent",
  description:
    "Intent & Deep Link Engine. start: launch activity with extras. broadcast: send broadcast intent. deeplink: open deep link URI. services: list running services.",
  tools: intentTools,
  prefix: "intent_",
  extraSchema: {
    platform: {
      type: "string",
      enum: ["android", "ios"],
      description: "Target platform. If not specified, uses the active target.",
    },
  },
});

export const intentMeta = meta;
export const intentAliases = aliases;
