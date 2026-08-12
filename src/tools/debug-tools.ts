/**
 * `debug` — runtime debugger tools (Android JDWP + iOS LLDB).
 *
 * White-box debugging of a *debuggable* live app: attach, breakpoints, poll for
 * hits, inspect paused frames/locals, evaluate, mutate, step. Sessions are held
 * across calls by a module-singleton DebugController (the daemon role).
 *
 * Precondition: only debuggable builds are attachable — Android
 * android:debuggable=true, iOS get-task-allow (Debug config). Release/Store apps
 * are not debuggable, the runtime-debug analogue of the FLAG_SECURE screenshot
 * limit. iOS requires macOS + Xcode and (MVP) the Simulator.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { textResult, jsonResult } from "../utils/tool-result.js";
import { DebugController, type DebugPlatform } from "../debug/controller.js";
import type { AdbRunner } from "../debug/jdwp/session.js";

const pexec = promisify(execFile);

/** adb runner bound to an optional device serial (ADB_PATH honoured). */
function androidAdb(deviceId?: string): AdbRunner {
  const adbBin = process.env.ADB_PATH || "adb";
  return async (args: string[]) => {
    const full = deviceId ? ["-s", deviceId, ...args] : args;
    const { stdout } = await pexec(adbBin, full);
    return stdout;
  };
}

// One controller for the whole process — holds sessions across tool calls.
let controller: DebugController | undefined;
function ctrl(): DebugController {
  if (!controller) controller = new DebugController((deviceId) => androidAdb(deviceId));
  return controller;
}

/**
 * Tear down all debug sessions (dispose VMs, remove adb forwards, kill the LLDB
 * daemon). Call from process shutdown so nothing is leaked/orphaned.
 */
export async function disposeDebugSessions(): Promise<void> {
  await controller?.disposeAll();
  controller = undefined;
}

export const debugTools: ToolDefinition[] = [
  defineTool({
    name: "debug_attach",
    description:
      "Attach the runtime debugger to a DEBUGGABLE running app. Android (JDWP): pass the package of an android:debuggable=true build. Returns a sessionId for all other debug calls. (iOS/Simulator support lands in 3.16 — attaching with platform:'ios' is rejected in this release.)",
    schema: z.object({
      platform: z.enum(["android", "ios"]).describe("android (JDWP) or ios (LLDB, Simulator)."),
      app: z.string().describe("Android package name or iOS bundle id."),
      launch: z.boolean().default(true).describe("iOS: launch the app suspended before attaching (default true)."),
      deviceId: z.string().optional().describe("Android device/emulator serial (optional)."),
    }),
    handler: async (args) => {
      const res = await ctrl().attach({
        platform: args.platform as DebugPlatform,
        app: args.app,
        deviceId: args.deviceId,
        launch: args.launch,
      });
      return jsonResult(res);
    },
  }),

  defineTool({
    name: "debug_break",
    description:
      "Set a breakpoint. Android: {className, line} or {className, method} (method-entry, robust without line info). iOS: {file, line} or {method}. Returns { id, verified }.",
    schema: z.object({
      sessionId: z.string(),
      className: z.string().optional().describe("Android: dotted class name, e.g. com.app.MainActivity."),
      method: z.string().optional().describe("Method name for a method/function breakpoint."),
      file: z.string().optional().describe("iOS: source file name, e.g. ContentView.swift."),
      line: z.number().optional().describe("Source line number."),
    }),
    handler: async (args) => {
      const res = await ctrl().setBreakpoint(args.sessionId, {
        className: args.className,
        method: args.method,
        file: args.file,
        line: args.line,
      });
      return jsonResult(res);
    },
  }),

  defineTool({
    name: "debug_remove_break",
    description: "Remove a breakpoint by its id.",
    schema: z.object({ sessionId: z.string(), breakpointId: z.string() }),
    handler: async (args) => {
      await ctrl().removeBreakpoint(args.sessionId, args.breakpointId);
      return textResult(`Removed breakpoint ${args.breakpointId}`);
    },
  }),

  defineTool({
    name: "debug_poll",
    description:
      "Poll the event queue for hits (BREAKPOINT_HIT / STEP_HIT / EXCEPTION_HIT / CLASS_PREPARE / VM_DEATH). Never blocks. Start cursor at 0, reuse nextCursor. If empty, ask the user to interact with the app, then poll again.",
    schema: z.object({ sessionId: z.string(), cursor: z.number().default(0) }),
    handler: async (args) => {
      const res = await ctrl().poll(args.sessionId, args.cursor);
      return jsonResult(res);
    },
  }),

  defineTool({
    name: "debug_pause_state",
    description: "Inspect a paused thread: call stack frames (with line numbers) and the top frame's locals (name/type/value, objectId for objects).",
    schema: z.object({ sessionId: z.string(), threadId: z.string() }),
    handler: async (args) => {
      const res = await ctrl().pauseState(args.sessionId, args.threadId);
      return jsonResult(res);
    },
  }),

  defineTool({
    name: "debug_eval",
    description:
      "Evaluate an expression on a paused thread. Android supports: a local name, `name.field`, or `name.method(args)` with literal args (int/long/float/bool/null/\"str\"); `this` is a valid receiver. iOS: full LLDB expression eval.",
    schema: z.object({ sessionId: z.string(), threadId: z.string(), expr: z.string() }),
    handler: async (args) => {
      const res = await ctrl().eval(args.sessionId, args.threadId, args.expr);
      return jsonResult(res);
    },
  }),

  defineTool({
    name: "debug_set_var",
    description:
      "Mutate a local variable on a paused thread. Android: primitives (int/long/bool/float/…), null, and strings; the value is coerced to the local's declared type. iOS: LLDB set / expression assignment.",
    schema: z.object({ sessionId: z.string(), threadId: z.string(), name: z.string(), value: z.string() }),
    handler: async (args) => {
      const res = await ctrl().setVar(args.sessionId, args.threadId, args.name, args.value);
      return jsonResult(res);
    },
  }),

  defineTool({
    name: "debug_step",
    description: "Step the paused thread: OVER, INTO, or OUT. Then poll for the STEP_HIT.",
    schema: z.object({
      sessionId: z.string(),
      threadId: z.string(),
      action: z.enum(["OVER", "INTO", "OUT"]).default("OVER"),
    }),
    handler: async (args) => {
      await ctrl().step(args.sessionId, args.threadId, args.action as "OVER" | "INTO" | "OUT");
      return textResult(`step ${args.action} issued — poll for STEP_HIT`);
    },
  }),

  defineTool({
    name: "debug_resume",
    description: "Resume all threads in the debugged VM/process.",
    schema: z.object({ sessionId: z.string() }),
    handler: async (args) => {
      await ctrl().resume(args.sessionId);
      return textResult("resumed");
    },
  }),

  defineTool({
    name: "debug_detach",
    description: "Detach the debugger and end the session (the app keeps running).",
    schema: z.object({ sessionId: z.string() }),
    handler: async (args) => {
      await ctrl().detach(args.sessionId);
      return textResult(`detached ${args.sessionId}`);
    },
  }),

  defineTool({
    name: "debug_threads",
    description: "List threads of the debugged VM with ids and names (Android). Use an id to inspect/step a specific thread.",
    schema: z.object({ sessionId: z.string() }),
    handler: async (args) => jsonResult(await ctrl().threads(args.sessionId)),
  }),

  defineTool({
    name: "debug_sessions",
    description: "List active debug sessions.",
    schema: z.object({}),
    handler: async () => jsonResult(ctrl().listSessions()),
  }),
];
