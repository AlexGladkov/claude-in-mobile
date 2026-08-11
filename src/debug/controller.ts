/**
 * DebugController — the cross-platform runtime-debug session manager.
 *
 * Holds live debug sessions across MCP tool calls (the "daemon" role): Android
 * sessions speak JDWP directly (JdwpDebugger); iOS sessions are proxied to the
 * LLDB Python sidecar (LldbClient). The MCP `debug` tool talks only to this
 * controller, which dispatches by platform and returns JSON-serialisable data.
 */

import { attachAndroid, resolvePid, type AdbRunner } from "./jdwp/session.js";
import type { JdwpSession } from "./jdwp/session.js";
import { JdwpDebugger } from "./jdwp/debugger.js";
import { LldbClient } from "./lldb/client.js";

export type DebugPlatform = "android" | "ios";

export interface AttachResult {
  sessionId: string;
  platform: DebugPlatform;
  pid?: number;
}

interface AndroidEntry {
  platform: "android";
  session: JdwpSession;
  dbg: JdwpDebugger;
}
interface IosEntry {
  platform: "ios";
  iosSessionId: string;
}
type Entry = AndroidEntry | IosEntry;

/** Injected so the controller stays decoupled from AdbClient/DeviceManager. */
export type AndroidAdbFactory = (deviceId?: string) => AdbRunner;

export class DebugController {
  private sessions = new Map<string, Entry>();
  private lldb?: LldbClient;
  private nextId = 1;
  private nextPort = 8100;

  constructor(
    private readonly androidAdb: AndroidAdbFactory,
    private readonly makeLldb: () => LldbClient = () => new LldbClient(),
  ) {}

  private id(): string {
    return `dbg_${this.nextId++}`;
  }

  // ---------- attach / detach ----------

  async attach(opts: {
    platform: DebugPlatform;
    app: string; // android package or ios bundle id
    deviceId?: string;
    launch?: boolean;
  }): Promise<AttachResult> {
    if (opts.platform === "android") {
      const adb = this.androidAdb(opts.deviceId);
      const pid = await resolvePid(adb, opts.app);
      const session = await attachAndroid({ pid, adb, localPort: this.nextPort++ });
      const dbg = new JdwpDebugger(session);
      const sessionId = this.id();
      this.sessions.set(sessionId, { platform: "android", session, dbg });
      return { sessionId, platform: "android", pid };
    }

    // iOS → LLDB sidecar
    const client = await this.ios();
    const res = await client.rpc("attach", { bundleId: opts.app, launch: opts.launch ?? true });
    const sessionId = this.id();
    this.sessions.set(sessionId, { platform: "ios", iosSessionId: res.sessionId });
    return { sessionId, platform: "ios", pid: res.pid };
  }

  async detach(sessionId: string): Promise<void> {
    const e = this.get(sessionId);
    if (e.platform === "android") {
      await e.session.dispose();
    } else {
      await this.ios().then((c) => c.rpc("detach", { sessionId: e.iosSessionId }));
    }
    this.sessions.delete(sessionId);
  }

  // ---------- breakpoints ----------

  async setBreakpoint(
    sessionId: string,
    spec: { className?: string; method?: string; file?: string; line?: number },
  ): Promise<{ id: string; verified: boolean }> {
    const e = this.get(sessionId);
    if (e.platform === "android") {
      if (spec.className && spec.method != null && spec.line == null) {
        const r = await e.dbg.setMethodBreakpoint(spec.className, spec.method, true);
        return { id: String(r.requestId ?? ""), verified: r.verified };
      }
      if (spec.className && spec.line != null) {
        const r = await e.dbg.setLineBreakpoint(spec.className, spec.line, true);
        return { id: String(r.requestId ?? ""), verified: r.verified };
      }
      throw new Error("android breakpoint needs {className, line} or {className, method}");
    }
    const c = await this.ios();
    if (spec.file && spec.line != null) {
      const r = await c.rpc("setBreakpoint", { sessionId: e.iosSessionId, file: spec.file, line: spec.line });
      return { id: String(r.breakpointId), verified: !!r.verified };
    }
    if (spec.method) {
      const r = await c.rpc("setFunctionBreakpoint", { sessionId: e.iosSessionId, symbol: spec.method });
      return { id: String(r.breakpointId), verified: !!r.verified };
    }
    throw new Error("ios breakpoint needs {file, line} or {method}");
  }

  async removeBreakpoint(sessionId: string, breakpointId: string): Promise<void> {
    const e = this.get(sessionId);
    if (e.platform === "android") {
      await e.dbg.clearBreakpoint(parseInt(breakpointId, 10));
    } else {
      await this.ios().then((c) => c.rpc("removeBreakpoint", { sessionId: e.iosSessionId, breakpointId }));
    }
  }

  // ---------- poll / inspect / step ----------

  async poll(sessionId: string, cursor: number): Promise<{ events: unknown[]; nextCursor: number }> {
    const e = this.get(sessionId);
    if (e.platform === "android") return e.dbg.poll(cursor);
    const c = await this.ios();
    return c.rpc("poll", { sessionId: e.iosSessionId, cursor });
  }

  async pauseState(sessionId: string, threadId: string): Promise<unknown> {
    const e = this.get(sessionId);
    if (e.platform === "android") return e.dbg.pauseState(BigInt(threadId));
    const c = await this.ios();
    return c.rpc("pauseState", { sessionId: e.iosSessionId, threadId });
  }

  async eval(sessionId: string, threadId: string, expr: string): Promise<unknown> {
    const e = this.get(sessionId);
    if (e.platform === "ios") {
      const c = await this.ios();
      return c.rpc("eval", { sessionId: e.iosSessionId, threadId, expr });
    }
    // Android expression eval (InvokeMethod) is not implemented yet.
    throw new Error("eval is not yet supported on Android (JDWP InvokeMethod pending)");
  }

  async setVar(sessionId: string, threadId: string, name: string, value: string): Promise<unknown> {
    const e = this.get(sessionId);
    if (e.platform === "ios") {
      const c = await this.ios();
      return c.rpc("setVar", { sessionId: e.iosSessionId, threadId, name, value });
    }
    throw new Error("setVar is not yet supported on Android (JDWP InvokeMethod pending)");
  }

  async step(sessionId: string, threadId: string, action: "OVER" | "INTO" | "OUT"): Promise<void> {
    const e = this.get(sessionId);
    if (e.platform === "android") {
      await e.dbg.step(BigInt(threadId), action);
    } else {
      await this.ios().then((c) => c.rpc("step", { sessionId: e.iosSessionId, threadId, action }));
    }
  }

  async resume(sessionId: string): Promise<void> {
    const e = this.get(sessionId);
    if (e.platform === "android") await e.dbg.resume();
    else await this.ios().then((c) => c.rpc("step", { sessionId: e.iosSessionId, threadId: "0", action: "RESUME" }));
  }

  listSessions(): { sessionId: string; platform: DebugPlatform }[] {
    return [...this.sessions.entries()].map(([sessionId, e]) => ({ sessionId, platform: e.platform }));
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      try {
        await this.detach(id);
      } catch {
        /* best effort */
      }
    }
    await this.lldb?.stop();
    this.lldb = undefined;
  }

  private get(sessionId: string): Entry {
    const e = this.sessions.get(sessionId);
    if (!e) throw new Error(`Unknown debug session ${sessionId}`);
    return e;
  }

  private async ios(): Promise<LldbClient> {
    if (!this.lldb) {
      this.lldb = this.makeLldb();
      await this.lldb.start();
    }
    return this.lldb;
  }
}
