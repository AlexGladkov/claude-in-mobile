import { createMetaTool } from "./create-meta-tool.js";
import { debugTools } from "../debug-tools.js";

const { meta, aliases } = createMetaTool({
  name: "debug",
  description:
    "Runtime debugger for a DEBUGGABLE live Android app (JDWP). attach → break → poll (for hits) → pause_state (frames+locals) → eval / set_var / step → resume / detach. Only android:debuggable=true builds are attachable (same idea as the FLAG_SECURE screenshot limit). iOS/Simulator (LLDB) support ships in 3.16.",
  tools: debugTools,
  prefix: "debug_",
  extraSchema: {
    platform: { type: "string", enum: ["android", "ios"], description: "android (JDWP) or ios (LLDB, Simulator)." },
    sessionId: { type: "string", description: "Session id from debug attach." },
    app: { type: "string", description: "Android package or iOS bundle id (attach)." },
    className: { type: "string", description: "Android dotted class name (break)." },
    method: { type: "string", description: "Method/function name (break)." },
    file: { type: "string", description: "iOS source file (break)." },
    line: { type: "number", description: "Source line (break)." },
    threadId: { type: "string", description: "Thread id from a poll hit." },
    cursor: { type: "number", description: "Poll cursor (start 0, reuse nextCursor)." },
    expr: { type: "string", description: "Expression to evaluate (eval)." },
    action: { type: "string", enum: ["OVER", "INTO", "OUT"], description: "Step direction." },
  },
});

export const debugMeta = meta;
export const debugAliases = aliases;
