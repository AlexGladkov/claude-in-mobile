import { createMetaTool } from "./create-meta-tool.js";
import { flowTools } from "../flow-tools.js";

/**
 * Meta tool for flow orchestration: batch, run, parallel.
 *
 * Consolidates flow_batch, flow_run, flow_parallel into a single
 * `flow(action:'batch'|'run'|'parallel')` entry point, consistent
 * with the meta-tool pattern used by all other tool domains.
 */
const { meta, aliases } = createMetaTool({
  name: "flow",
  description:
    "Flow orchestration: batch (multi-command), run (multi-step automation with loops/conditionals), parallel (same action on multiple devices)",
  tools: flowTools,
  prefix: "flow_",
});

export const flowMeta = meta;
export const flowAliases = aliases;
