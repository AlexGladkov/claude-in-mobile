/**
 * tools.ts — MCP ToolDefinition array for the debug plugin.
 *
 * All 12 tools: attach · break · remove_break · poll · pause_state ·
 * threads · eval · set_var · step · resume · detach · sessions.
 *
 * Each tool's inputSchema is generated with JSON Schema draft 2020-12
 * (draft-07 array-form items from z.tuple() causes 400 errors — #57).
 *
 * Security: eval/pause_state/inspect results are sanitized to strip
 * secret-like values and enforce length caps before returning to the model.
 */

import { z } from "zod";
import type { ToolDefinition } from "@mcp-devices/plugin-api";
import type { DebugController } from "./controller.js";

/** Hard cap on eval/local value length returned to the model (invariant 4). */
const MAX_VALUE_LEN = 512;

/** Patterns that look like secrets — redacted before sending to the model. */
const SECRET_PATTERNS = [
  /(?:password|passwd|secret|token|api.?key|auth.?key|bearer|credential|private.?key|access.?key)/i,
  /^[A-Za-z0-9+/]{40,}={0,2}$/, // base64-like long strings (keys, JWTs)
  /^[0-9a-fA-F]{32,}$/, // hex strings (tokens/hashes)
  /eyJ[A-Za-z0-9._-]{20,}/, // JWT prefix
];

function isSecretLike(name: string, value: string): boolean {
  if (SECRET_PATTERNS.slice(0, 1).some((re) => re.test(name))) return true;
  if (typeof value === "string" && SECRET_PATTERNS.slice(1).some((re) => re.test(value.trim()))) {
    return true;
  }
  return false;
}

function sanitizeValue(name: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (isSecretLike(name, value)) return "[REDACTED]";
  if (value.length > MAX_VALUE_LEN) return value.slice(0, MAX_VALUE_LEN) + "…[truncated]";
  return value;
}

/**
 * Sanitize a pauseState / eval result object before returning it to the model.
 * Mutates a deep-copy (does not modify the original).
 */
function sanitizeResult(data: unknown): unknown {
  if (data == null || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map((item) => sanitizeResult(item));

  const obj = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      out[k] = sanitizeValue(k, v);
    } else if (typeof v === "object" && v !== null) {
      out[k] = sanitizeResult(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Build a ToolDefinition with a JSON Schema draft 2020-12 inputSchema.
 * The `handler` receives the raw (untyped) args — the tool validates only
 * structural shape; the controller validates semantic invariants.
 */
function makeTool<S extends z.ZodTypeAny>(opts: {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.output<S>, ctrl: DebugController) => Promise<unknown>;
}): (ctrl: DebugController) => ToolDefinition {
  const jsonSchema = z.toJSONSchema(opts.schema, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;

  return (ctrl: DebugController): ToolDefinition => ({
    name: opts.name,
    description: opts.description,
    inputSchema: jsonSchema,
    async handler(rawArgs: unknown): Promise<unknown> {
      const parsed = opts.schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new Error(`Invalid arguments for ${opts.name}: ${issues}`);
      }
      return opts.handler(parsed.data as z.output<S>, ctrl);
    },
  });
}

// ---------- Tool factories ----------

const attachToolFactory = makeTool({
  name: "debug_attach",
  description:
    "Attach the runtime debugger to a DEBUGGABLE running app. Android (JDWP): the package must have android:debuggable=true. iOS (LLDB Simulator): requires macOS + Xcode. Returns a sessionId for all subsequent debug calls.",
  schema: z.object({
    platform: z.enum(["android", "ios"]).describe("android (JDWP) or ios (LLDB, Simulator)."),
    app: z.string().describe("Android package name (e.g. com.app.debug) or iOS bundle id."),
    launch: z
      .boolean()
      .default(true)
      .describe("iOS: launch the app suspended before attaching (default true)."),
    deviceId: z
      .string()
      .optional()
      .describe("Android device/emulator serial (optional; uses default device if omitted)."),
  }),
  handler: async (args, ctrl) => {
    return ctrl.attach({
      platform: args.platform,
      app: args.app,
      deviceId: args.deviceId,
      launch: args.launch,
    });
  },
});

const breakToolFactory = makeTool({
  name: "debug_break",
  description:
    "Set a breakpoint. Android: {className, line} or {className, method} (method-entry, robust without line info). iOS: {file, line} or {method}. Returns { id, verified }. verified=false means the class is not yet loaded — the breakpoint will arm on CLASS_PREPARE.",
  schema: z.object({
    sessionId: z.string().describe("Session id from debug_attach."),
    className: z
      .string()
      .optional()
      .describe("Android: dotted class name, e.g. com.app.MainActivity."),
    method: z
      .string()
      .optional()
      .describe("Android: method name for a method-entry breakpoint. iOS: function symbol."),
    file: z.string().optional().describe("iOS: source file name, e.g. ContentView.swift."),
    line: z.number().optional().describe("Source line number."),
  }),
  handler: async (args, ctrl) => {
    return ctrl.setBreakpoint(args.sessionId, {
      className: args.className,
      method: args.method,
      file: args.file,
      line: args.line,
    });
  },
});

const removeBreakToolFactory = makeTool({
  name: "debug_remove_break",
  description: "Remove a breakpoint by its id (returned by debug_break).",
  schema: z.object({
    sessionId: z.string(),
    breakpointId: z.string().describe("Breakpoint id from debug_break."),
  }),
  handler: async (args, ctrl) => {
    await ctrl.removeBreakpoint(args.sessionId, args.breakpointId);
    return { ok: true, removed: args.breakpointId };
  },
});

const pollToolFactory = makeTool({
  name: "debug_poll",
  description:
    "Poll the event queue for hits (BREAKPOINT_HIT / STEP_HIT / EXCEPTION_HIT / CLASS_PREPARE / VM_DEATH). Never blocks. Start cursor at 0, advance nextCursor on each call. If the queue is empty, ask the user to interact with the app, then poll again.",
  schema: z.object({
    sessionId: z.string(),
    cursor: z.number().default(0).describe("Cursor from the previous poll (start at 0)."),
  }),
  handler: async (args, ctrl) => {
    return ctrl.poll(args.sessionId, args.cursor);
  },
});

const pauseStateToolFactory = makeTool({
  name: "debug_pause_state",
  description:
    "Inspect a paused thread: call stack frames (class, method, line) and the top frame's locals (name / type / value; objectId for object-typed locals). Thread must be suspended (use debug_poll to confirm BREAKPOINT_HIT/STEP_HIT first).",
  schema: z.object({
    sessionId: z.string(),
    threadId: z
      .string()
      .describe("Thread id (decimal string from debug_poll or debug_threads)."),
  }),
  handler: async (args, ctrl) => {
    // SECURITY I4: sanitize locals/values before returning to the model.
    const raw = await ctrl.pauseState(args.sessionId, args.threadId);
    return sanitizeResult(raw);
  },
});

const threadsToolFactory = makeTool({
  name: "debug_threads",
  description:
    "List threads of the debugged VM with ids and names (Android). Use an id with debug_pause_state / debug_step to target a specific thread.",
  schema: z.object({
    sessionId: z.string(),
  }),
  handler: async (args, ctrl) => {
    return ctrl.threads(args.sessionId);
  },
});

const evalToolFactory = makeTool({
  name: "debug_eval",
  description:
    "Evaluate an expression on a paused thread. Android: a local name, `name.field`, or `name.method(args)` with literal args (int/long/float/bool/null/\"str\"); `this` is a valid receiver. iOS: full LLDB expression eval. Thread must be suspended.",
  schema: z.object({
    sessionId: z.string(),
    threadId: z.string().describe("Thread id (decimal string)."),
    expr: z
      .string()
      .describe(
        "Expression: a local name, name.field, or name.method(literal_args). E.g. `count`, `user.name`, `list.size()`.",
      ),
  }),
  handler: async (args, ctrl) => {
    // SECURITY I4: sanitize eval result — never raw heap bytes to the model.
    const raw = await ctrl.eval(args.sessionId, args.threadId, args.expr);
    return sanitizeResult(raw);
  },
});

const setVarToolFactory = makeTool({
  name: "debug_set_var",
  description:
    "Mutate a local variable on a paused thread. Android: primitives (int/long/bool/float/…), null, and strings; the value is coerced to the local's declared type. iOS: LLDB set / expression assignment. Thread must be suspended.",
  schema: z.object({
    sessionId: z.string(),
    threadId: z.string(),
    name: z.string().describe("Local variable name (must be in scope at the top frame)."),
    value: z
      .string()
      .describe("New value as a string; coerced to the variable's declared type."),
  }),
  handler: async (args, ctrl) => {
    return ctrl.setVar(args.sessionId, args.threadId, args.name, args.value);
  },
});

const stepToolFactory = makeTool({
  name: "debug_step",
  description:
    "Step the paused thread: OVER (next line), INTO (into call), or OUT (out of current method). Issues the step and resumes the thread; poll for STEP_HIT to see where execution landed.",
  schema: z.object({
    sessionId: z.string(),
    threadId: z.string(),
    action: z
      .enum(["OVER", "INTO", "OUT"])
      .default("OVER")
      .describe("OVER: next line. INTO: step into call. OUT: step out of method."),
  }),
  handler: async (args, ctrl) => {
    await ctrl.step(args.sessionId, args.threadId, args.action);
    return { ok: true, action: args.action, hint: "poll for STEP_HIT" };
  },
});

const resumeToolFactory = makeTool({
  name: "debug_resume",
  description:
    "Resume all threads in the debugged VM/process. Use after inspecting a paused state to let the app continue running.",
  schema: z.object({
    sessionId: z.string(),
  }),
  handler: async (args, ctrl) => {
    await ctrl.resume(args.sessionId);
    return { ok: true, resumed: true };
  },
});

const detachToolFactory = makeTool({
  name: "debug_detach",
  description:
    "Detach the debugger and end the session (the app keeps running). Also tears down the adb forward / LLDB daemon for this session.",
  schema: z.object({
    sessionId: z.string(),
  }),
  handler: async (args, ctrl) => {
    await ctrl.detach(args.sessionId);
    return { ok: true, detached: args.sessionId };
  },
});

const sessionsToolFactory = makeTool({
  name: "debug_sessions",
  description:
    "List active debug sessions (sessionId + platform). Useful to discover open sessions before attaching or after a crash.",
  schema: z.object({}),
  handler: async (_args, ctrl) => {
    return { sessions: ctrl.listSessions() };
  },
});

/** All debug tool factories (one per ToolDefinition). Bound to a controller instance by the plugin. */
export const DEBUG_TOOL_FACTORIES = [
  attachToolFactory,
  breakToolFactory,
  removeBreakToolFactory,
  pollToolFactory,
  pauseStateToolFactory,
  threadsToolFactory,
  evalToolFactory,
  setVarToolFactory,
  stepToolFactory,
  resumeToolFactory,
  detachToolFactory,
  sessionsToolFactory,
] as const;

/** Build the full ToolDefinition array bound to a given controller. */
export function buildDebugTools(ctrl: DebugController): ToolDefinition[] {
  return DEBUG_TOOL_FACTORIES.map((factory) => factory(ctrl));
}
