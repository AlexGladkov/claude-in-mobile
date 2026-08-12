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
import { validatePackageName, validateDeviceId, validateBundleId } from "../utils/sanitize.js";

/** Hard cap on concurrent debug sessions — bounds ports/daemon/socket growth. */
const MAX_SESSIONS = 16;

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
  port: number;
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
  private static readonly PORT_BASE = 8100;
  private usedPorts = new Set<number>();

  constructor(
    private readonly androidAdb: AndroidAdbFactory,
    private readonly makeLldb: () => LldbClient = () => new LldbClient(),
  ) {}

  private id(): string {
    return `dbg_${this.nextId++}`;
  }

  /** Count sessions that are still alive (dead ones don't hold the cap). */
  private aliveSessionCount(): number {
    let n = 0;
    for (const e of this.sessions.values()) {
      if (e.platform === "ios" || e.dbg.alive) n++;
    }
    return n;
  }

  /** Evict Android sessions whose VM/socket has died (forward already freed). */
  private reapDeadSessions(): void {
    for (const [id, e] of [...this.sessions.entries()]) {
      if (e.platform === "android" && !e.dbg.alive) {
        this.sessions.delete(id);
        this.locks.delete(id);
      }
    }
  }

  /** Lowest free localhost port for an adb JDWP forward (recycled on detach). */
  private allocPort(): number {
    for (let p = DebugController.PORT_BASE; p < DebugController.PORT_BASE + 4096; p++) {
      if (!this.usedPorts.has(p)) {
        this.usedPorts.add(p);
        return p;
      }
    }
    throw new Error("no free debug port available");
  }

  // ---------- attach / detach ----------

  async attach(opts: {
    platform: DebugPlatform;
    app: string; // android package or ios bundle id
    deviceId?: string;
    launch?: boolean;
  }): Promise<AttachResult> {
    if (opts.platform === "ios") {
      // iOS runtime debug (LLDB Simulator backend) is not enabled in this
      // release — it ships in 3.16 after the sidecar hardening pass.
      throw new Error("iOS runtime debug is not enabled in this release (Android only; iOS lands in 3.16)");
    }

    this.reapDeadSessions();
    if (this.aliveSessionCount() >= MAX_SESSIONS) {
      throw new Error(`too many debug sessions (max ${MAX_SESSIONS}) — detach some first`);
    }

    if (opts.platform === "android") {
      // Agent-supplied strings reach `adb shell` (device-side sh) — validate.
      validatePackageName(opts.app);
      if (opts.deviceId) validateDeviceId(opts.deviceId);

      const adb = this.androidAdb(opts.deviceId);
      const pid = await resolvePid(adb, opts.app);
      const port = this.allocPort();
      let session: JdwpSession;
      try {
        session = await attachAndroid({ pid, adb, localPort: port });
      } catch (e) {
        this.usedPorts.delete(port); // attachAndroid already removed its forward
        throw e;
      }
      const dbg = new JdwpDebugger(session);
      const sessionId = this.id();
      const entry: AndroidEntry = { platform: "android", session, dbg, port };
      this.sessions.set(sessionId, entry);
      // Free the port when the VM/socket dies; keep the session so the agent's
      // next poll delivers the terminal VM_DEATH event (JdwpDebugger pushes it).
      session.onClose(() => this.usedPorts.delete(port));
      return { sessionId, platform: "android", pid };
    }

    // iOS → LLDB sidecar (bundle id reaches simctl/launchctl argv — validate).
    validateBundleId(opts.app);
    const client = await this.ios();
    const res = await client.rpc("attach", { bundleId: opts.app, launch: opts.launch ?? true });
    const sessionId = this.id();
    this.sessions.set(sessionId, { platform: "ios", iosSessionId: res.sessionId });
    return { sessionId, platform: "ios", pid: res.pid };
  }

  async detach(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) return; // idempotent (already reaped/detached)
    // Serialize teardown after any in-flight op on this session so we don't
    // destroy the socket/frames out from under a pending pauseState/step.
    await this.lock(sessionId, async () => {
      const e = this.sessions.get(sessionId);
      if (!e) return;
      if (e.platform === "android") {
        await e.session.dispose();
        this.usedPorts.delete(e.port);
      } else {
        await this.ios().then((c) => c.rpc("detach", { sessionId: e.iosSessionId }));
      }
      this.sessions.delete(sessionId);
    });
    this.locks.delete(sessionId);
  }

  // Per-session serialization: debug ops mutate shared VM/thread state, so
  // concurrent tool calls on one session must not interleave (a step resuming
  // while another reads frames → INVALID_FRAMEID). poll is included so its
  // lazy request round-trips don't race a mutating op.
  private locks = new Map<string, Promise<unknown>>();
  private lock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // ---------- breakpoints ----------

  setBreakpoint(
    sessionId: string,
    spec: { className?: string; method?: string; file?: string; line?: number },
  ): Promise<{ id: string; verified: boolean }> {
    return this.lock(sessionId, async () => {
      const e = this.get(sessionId);
      if (e.platform === "android") {
        if (spec.className && spec.method != null && spec.line == null) {
          const r = await e.dbg.setMethodBreakpoint(spec.className, spec.method, true);
          return { id: r.requestId != null ? String(r.requestId) : "", verified: r.verified };
        }
        if (spec.className && spec.line != null) {
          const r = await e.dbg.setLineBreakpoint(spec.className, spec.line, true);
          return { id: r.requestId != null ? String(r.requestId) : "", verified: r.verified };
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
    });
  }

  removeBreakpoint(sessionId: string, breakpointId: string): Promise<void> {
    return this.lock(sessionId, async () => {
      const e = this.get(sessionId);
      if (e.platform === "android") {
        await e.dbg.clearBreakpoint(intId(breakpointId, "breakpointId"));
      } else {
        await this.ios().then((c) => c.rpc("removeBreakpoint", { sessionId: e.iosSessionId, breakpointId }));
      }
    });
  }

  // ---------- poll / inspect / step ----------

  poll(sessionId: string, cursor: number): Promise<{ events: unknown[]; nextCursor: number }> {
    return this.lock(sessionId, async () => {
      const e = this.get(sessionId);
      if (e.platform === "android") return e.dbg.poll(cursor);
      const c = await this.ios();
      return c.rpc("poll", { sessionId: e.iosSessionId, cursor });
    });
  }

  pauseState(sessionId: string, threadId: string): Promise<unknown> {
    return this.lock(sessionId, async () => {
      const e = this.get(sessionId);
      if (e.platform === "android") return e.dbg.pauseState(bigId(threadId, "threadId"));
      const c = await this.ios();
      return c.rpc("pauseState", { sessionId: e.iosSessionId, threadId });
    });
  }

  eval(sessionId: string, threadId: string, expr: string): Promise<unknown> {
    return this.lock(sessionId, async () => {
      const e = this.get(sessionId);
      if (e.platform === "ios") {
        const c = await this.ios();
        return c.rpc("eval", { sessionId: e.iosSessionId, threadId, expr });
      }
      return e.dbg.eval(bigId(threadId, "threadId"), expr);
    });
  }

  setVar(sessionId: string, threadId: string, name: string, value: string): Promise<unknown> {
    return this.lock(sessionId, async () => {
      const e = this.get(sessionId);
      if (e.platform === "ios") {
        const c = await this.ios();
        return c.rpc("setVar", { sessionId: e.iosSessionId, threadId, name, value });
      }
      await e.dbg.setVar(bigId(threadId, "threadId"), name, value);
      return { ok: true };
    });
  }

  step(sessionId: string, threadId: string, action: "OVER" | "INTO" | "OUT"): Promise<void> {
    return this.lock(sessionId, async () => {
      const e = this.get(sessionId);
      if (e.platform === "android") {
        await e.dbg.step(bigId(threadId, "threadId"), action);
      } else {
        await this.ios().then((c) => c.rpc("step", { sessionId: e.iosSessionId, threadId, action }));
      }
    });
  }

  resume(sessionId: string): Promise<void> {
    return this.lock(sessionId, async () => {
      const e = this.get(sessionId);
      if (e.platform === "android") await e.dbg.resume();
      else await this.ios().then((c) => c.rpc("step", { sessionId: e.iosSessionId, threadId: "0", action: "RESUME" }));
    });
  }

  /** List threads of the debugged VM (Android). */
  threads(sessionId: string): Promise<unknown> {
    return this.lock(sessionId, async () => {
      const e = this.get(sessionId);
      if (e.platform === "android") return e.session.listThreads();
      throw new Error("thread listing is not yet available on iOS");
    });
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

/** Parse an agent-supplied JDWP object/thread id (decimal) into a bigint. */
function bigId(v: string, label: string): bigint {
  if (!/^-?\d+$/.test(v.trim())) throw new Error(`invalid ${label}: ${JSON.stringify(v)}`);
  return BigInt(v.trim());
}

/** Parse an agent-supplied breakpoint/request id (int) safely. */
function intId(v: string, label: string): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`invalid ${label}: ${JSON.stringify(v)}`);
  return n;
}
