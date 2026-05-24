import { createMetaTool } from "./create-meta-tool.js";
import { networkTools } from "../network-tools.js";

const { meta, aliases } = createMetaTool({
  name: "network",
  description:
    "Network Layer. traffic: app network traffic stats. connectivity: connection type/state. proxy: get/set HTTP proxy. airplane: toggle airplane mode.",
  tools: networkTools,
  prefix: "network_",
  extraSchema: {
    platform: {
      type: "string",
      enum: ["android"],
      description: "Target platform (network tools are Android-only).",
    },
  },
});

export const networkMeta = meta;
export const networkAliases = aliases;
