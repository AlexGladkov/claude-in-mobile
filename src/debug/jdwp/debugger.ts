/**
 * JdwpDebugger — the debugging surface on top of a JdwpSession: class/method
 * resolution, breakpoints, an event poll-queue, stack frames + locals, and
 * stepping. Agent-facing model is poll-based (never blocks): set traps, poll a
 * cursor for hits, inspect the paused thread, resume/step.
 */

import type { JdwpSession } from "./session.js";
import type { JdwpConnection } from "./connection.js";
import { JdwpReader, JdwpWriter, type IdSizes } from "./packet.js";
import { decodeByTag, prettyTypeSignature, classNameToSignature, type DecodedValue } from "./values.js";
import {
  CommandSet,
  VirtualMachineCmd,
  ReferenceTypeCmd,
  MethodCmd,
  ThreadReferenceCmd,
  EventRequestCmd,
  StackFrameCmd,
  EventKind,
  SuspendPolicy,
  ModifierKind,
} from "./constants.js";

export interface JdwpLocation {
  typeTag: number;
  classID: bigint;
  methodID: bigint;
  index: bigint;
  className?: string;
  method?: string;
  line?: number;
}

export interface DebugEvent {
  cursor: number;
  kind: string; // BREAKPOINT_HIT | STEP_HIT | EXCEPTION_HIT | CLASS_PREPARE | VM_DEATH
  requestId?: number;
  threadId?: string;
  location?: { className?: string; method?: string; line?: number };
  exceptionType?: string;
}

export interface Frame {
  index: number;
  frameId: string;
  className: string;
  method: string;
  line?: number;
}

export interface Local {
  name: string;
  type: string;
  value: string; // rendered
  objectId?: string;
  tag: string;
}

interface MethodInfo {
  methodID: bigint;
  name: string;
  signature: string;
  modBits: number;
}

interface ClassInfo {
  typeTag: number;
  classID: bigint;
}

const STEP_SIZE_LINE = 1;
const STEP_DEPTH = { INTO: 0, OVER: 1, OUT: 2 } as const;

export class JdwpDebugger {
  private readonly conn: JdwpConnection;
  private readonly idSizes: IdSizes;
  private events: DebugEvent[] = [];
  private classCache = new Map<string, ClassInfo>(); // signature → class
  private methodCache = new Map<string, MethodInfo[]>(); // classID → methods
  private nameByClassId = new Map<string, string>();

  constructor(private readonly session: JdwpSession) {
    this.conn = session.connection;
    this.idSizes = session.idSizes;
    this.session.onEvent((cmd) => this.ingestComposite(cmd.data));
  }

  private req(set: number, cmd: number, data?: Buffer): Promise<Buffer> {
    return this.conn.request(set, cmd, data);
  }
  private w(): JdwpWriter {
    return new JdwpWriter(this.idSizes);
  }
  private r(buf: Buffer): JdwpReader {
    return new JdwpReader(buf, this.idSizes);
  }

  // ---------- class / method resolution ----------

  /** Resolve a loaded class by dotted name. Returns null if not yet loaded. */
  async findClass(className: string): Promise<ClassInfo | null> {
    const sig = classNameToSignature(className);
    const cached = this.classCache.get(sig);
    if (cached) return cached;

    const data = await this.req(
      CommandSet.VirtualMachine,
      VirtualMachineCmd.ClassesBySignature,
      this.w().string(sig).build(),
    );
    const r = this.r(data);
    const count = r.int();
    if (count === 0) return null;
    const typeTag = r.byte();
    const classID = r.referenceTypeID();
    const info: ClassInfo = { typeTag, classID };
    this.classCache.set(sig, info);
    this.nameByClassId.set(classID.toString(), className);
    return info;
  }

  /** List loaded classes (optionally filtered by a dotted-name substring). */
  async allClasses(filter?: string): Promise<{ className: string; classID: string }[]> {
    const data = await this.req(CommandSet.VirtualMachine, VirtualMachineCmd.AllClasses);
    const r = this.r(data);
    const count = r.int();
    const out: { className: string; classID: string }[] = [];
    for (let i = 0; i < count; i++) {
      r.byte(); // refTypeTag
      const classID = r.referenceTypeID();
      const sig = r.string();
      r.int(); // status
      if (sig.startsWith("L")) {
        const name = prettyTypeSignature(sig);
        if (!filter || name.includes(filter)) {
          out.push({ className: name, classID: classID.toString() });
          this.nameByClassId.set(classID.toString(), name);
        }
      }
    }
    return out;
  }

  private async methodsOf(classID: bigint): Promise<MethodInfo[]> {
    const key = classID.toString();
    const cached = this.methodCache.get(key);
    if (cached) return cached;

    const data = await this.req(
      CommandSet.ReferenceType,
      ReferenceTypeCmd.MethodsWithGeneric,
      this.w().referenceTypeID(classID).build(),
    );
    const r = this.r(data);
    const count = r.int();
    const methods: MethodInfo[] = [];
    for (let i = 0; i < count; i++) {
      const methodID = r.methodID();
      const name = r.string();
      const signature = r.string();
      r.string(); // generic signature (unused)
      const modBits = r.int();
      methods.push({ methodID, name, signature, modBits });
    }
    this.methodCache.set(key, methods);
    return methods;
  }

  private async lineTable(
    classID: bigint,
    methodID: bigint,
  ): Promise<{ lines: { index: bigint; line: number }[] } | null> {
    try {
      const data = await this.req(
        CommandSet.Method,
        MethodCmd.LineTable,
        this.w().referenceTypeID(classID).methodID(methodID).build(),
      );
      const r = this.r(data);
      r.long(); // start
      r.long(); // end
      const n = r.int();
      const lines: { index: bigint; line: number }[] = [];
      for (let i = 0; i < n; i++) lines.push({ index: r.long(), line: r.int() });
      return { lines };
    } catch {
      return null; // ABSENT_INFORMATION (no debug info)
    }
  }

  // ---------- breakpoints ----------

  /**
   * Line breakpoint by dotted class name + source line. Class must be loaded.
   * Returns { requestId, verified }. verified=false means class not loaded yet.
   */
  async setLineBreakpoint(
    className: string,
    line: number,
    suspendAll = false,
  ): Promise<{ requestId: number | null; verified: boolean }> {
    const cls = await this.findClass(className);
    if (!cls) return { requestId: null, verified: false };

    const methods = await this.methodsOf(cls.classID);
    for (const m of methods) {
      const lt = await this.lineTable(cls.classID, m.methodID);
      if (!lt) continue;
      // pick the code index for the exact line (or the first >= line in this method)
      const exact = lt.lines.find((l) => l.line === line);
      if (!exact) continue;
      const requestId = await this.setBreakpointAt(
        { typeTag: cls.typeTag, classID: cls.classID, methodID: m.methodID, index: exact.index },
        suspendAll,
      );
      return { requestId, verified: true };
    }
    return { requestId: null, verified: false };
  }

  /**
   * Method-entry breakpoint (code index 0). Robust even without line info —
   * useful to trap a known method regardless of source availability.
   */
  async setMethodBreakpoint(
    className: string,
    methodName: string,
    suspendAll = false,
  ): Promise<{ requestId: number | null; verified: boolean }> {
    const cls = await this.findClass(className);
    if (!cls) return { requestId: null, verified: false };
    const methods = await this.methodsOf(cls.classID);
    const m = methods.find((x) => x.name === methodName);
    if (!m) return { requestId: null, verified: false };
    const requestId = await this.setBreakpointAt(
      { typeTag: cls.typeTag, classID: cls.classID, methodID: m.methodID, index: 0n },
      suspendAll,
    );
    return { requestId, verified: true };
  }

  private async setBreakpointAt(loc: JdwpLocation, suspendAll: boolean): Promise<number> {
    const w = this.w()
      .byte(EventKind.BREAKPOINT)
      .byte(suspendAll ? SuspendPolicy.ALL : SuspendPolicy.EVENT_THREAD)
      .int(1) // one modifier
      .byte(ModifierKind.LocationOnly)
      .location(loc.typeTag, loc.classID, loc.methodID, loc.index);
    const data = await this.req(CommandSet.EventRequest, EventRequestCmd.Set, w.build());
    return this.r(data).int();
  }

  async clearBreakpoint(requestId: number): Promise<void> {
    const w = this.w().byte(EventKind.BREAKPOINT).int(requestId);
    await this.req(CommandSet.EventRequest, EventRequestCmd.Clear, w.build());
  }

  // ---------- events / poll ----------

  private ingestComposite(data: Buffer): void {
    const r = this.r(data);
    r.byte(); // suspendPolicy
    const count = r.int();
    for (let i = 0; i < count; i++) {
      const kind = r.byte();
      const requestId = r.int();
      const cursor = this.events.length;
      switch (kind) {
        case EventKind.BREAKPOINT:
        case EventKind.SINGLE_STEP:
        case EventKind.METHOD_ENTRY: {
          const threadId = r.threadID();
          const loc = r.location();
          this.events.push({
            cursor,
            kind: kind === EventKind.SINGLE_STEP ? "STEP_HIT" : "BREAKPOINT_HIT",
            requestId,
            threadId: threadId.toString(),
            location: this.describeLocation(loc),
          });
          break;
        }
        case EventKind.EXCEPTION: {
          const threadId = r.threadID();
          const loc = r.location();
          decodeByTag(r.byte(), r); // exception object (tagged) — skip payload for now
          r.location(); // catch location
          this.events.push({
            cursor,
            kind: "EXCEPTION_HIT",
            requestId,
            threadId: threadId.toString(),
            location: this.describeLocation(loc),
          });
          break;
        }
        case EventKind.CLASS_PREPARE: {
          const threadId = r.threadID();
          r.byte(); // refTypeTag
          r.referenceTypeID(); // typeID
          const sig = r.string();
          r.int(); // status
          this.events.push({
            cursor,
            kind: "CLASS_PREPARE",
            requestId,
            threadId: threadId.toString(),
            location: { className: prettyTypeSignature(sig) },
          });
          break;
        }
        case EventKind.VM_DEATH:
          this.events.push({ cursor, kind: "VM_DEATH", requestId });
          break;
        default:
          this.events.push({ cursor, kind: `UNKNOWN_${kind}`, requestId });
      }
    }
  }

  private describeLocation(loc: {
    classID: bigint;
    methodID: bigint;
    index: bigint;
  }): DebugEvent["location"] {
    const className = this.nameByClassId.get(loc.classID.toString());
    const methods = this.methodCache.get(loc.classID.toString());
    const method = methods?.find((m) => m.methodID === loc.methodID)?.name;
    return { className, method };
  }

  /** Return events at/after cursor and the next cursor to poll with. */
  poll(cursor: number): { events: DebugEvent[]; nextCursor: number } {
    const from = Math.max(0, cursor);
    return { events: this.events.slice(from), nextCursor: this.events.length };
  }

  // ---------- pause state ----------

  private async framesRaw(
    threadId: bigint,
    max: number,
  ): Promise<{ index: number; frameId: bigint; loc: { classID: bigint; methodID: bigint; index: bigint } }[]> {
    const w = this.w().threadID(threadId).int(0).int(max);
    const data = await this.req(CommandSet.ThreadReference, ThreadReferenceCmd.Frames, w.build());
    const r = this.r(data);
    const count = r.int();
    const out: { index: number; frameId: bigint; loc: { classID: bigint; methodID: bigint; index: bigint } }[] = [];
    for (let i = 0; i < count; i++) {
      const frameId = r.frameID();
      const loc = r.location();
      out.push({ index: i, frameId, loc: { classID: loc.classID, methodID: loc.methodID, index: loc.index } });
    }
    return out;
  }

  /** Resolve a class name on demand via ReferenceType.Signature (cached). */
  private async classNameOf(classID: bigint): Promise<string> {
    const key = classID.toString();
    const known = this.nameByClassId.get(key);
    if (known) return known;
    try {
      const data = await this.req(
        CommandSet.ReferenceType,
        ReferenceTypeCmd.Signature,
        this.w().referenceTypeID(classID).build(),
      );
      const sig = this.r(data).string();
      const name = prettyTypeSignature(sig);
      this.nameByClassId.set(key, name);
      return name;
    } catch {
      return `type#${classID}`;
    }
  }

  private async toFrame(raw: {
    index: number;
    frameId: bigint;
    loc: { classID: bigint; methodID: bigint; index: bigint };
  }): Promise<Frame> {
    const { classID, methodID, index } = raw.loc;
    // ensure method names are cached for this class (name resolution)
    if (!this.methodCache.has(classID.toString())) {
      try {
        await this.methodsOf(classID);
      } catch {
        /* class may be non-inspectable */
      }
    }
    const className = await this.classNameOf(classID);
    const method =
      this.methodCache.get(classID.toString())?.find((m) => m.methodID === methodID)?.name ??
      `method#${methodID}`;
    const line = await this.lineForIndex(classID, methodID, index);
    return { index: raw.index, frameId: raw.frameId.toString(), className, method, line };
  }

  async frames(threadId: bigint, max = 32): Promise<Frame[]> {
    const raw = await this.framesRaw(threadId, max);
    return Promise.all(raw.map((f) => this.toFrame(f)));
  }

  /** Top frames plus the locals of the top (current) frame — the agent pause view. */
  async pauseState(
    threadId: bigint,
    maxFrames = 16,
  ): Promise<{ frames: Frame[]; locals: Local[] }> {
    const raw = await this.framesRaw(threadId, maxFrames);
    const frames = await Promise.all(raw.map((f) => this.toFrame(f)));
    let locals: Local[] = [];
    if (raw.length > 0) {
      const top = raw[0];
      locals = await this.locals(
        threadId,
        top.frameId,
        top.loc.classID,
        top.loc.methodID,
        top.loc.index,
      );
    }
    return { frames, locals };
  }

  private async lineForIndex(classID: bigint, methodID: bigint, index: bigint): Promise<number | undefined> {
    const lt = await this.lineTable(classID, methodID);
    if (!lt || lt.lines.length === 0) return undefined;
    let best: number | undefined;
    for (const l of lt.lines) if (l.index <= index) best = l.line;
    return best;
  }

  /** Locals of a specific frame (variables in scope at the frame's code index). */
  async locals(threadId: bigint, frameId: bigint, classID: bigint, methodID: bigint, index: bigint): Promise<Local[]> {
    // variable table (slots valid over [codeIndex, codeIndex+length))
    let slots: { slot: number; name: string; sig: string; start: bigint; length: number }[] = [];
    try {
      const data = await this.req(
        CommandSet.Method,
        MethodCmd.VariableTableWithGeneric,
        this.w().referenceTypeID(classID).methodID(methodID).build(),
      );
      const r = this.r(data);
      r.int(); // argCnt
      const n = r.int();
      for (let i = 0; i < n; i++) {
        const start = r.long();
        const name = r.string();
        const sig = r.string();
        r.string(); // generic
        const length = r.int();
        const slot = r.int();
        slots.push({ slot, name, sig, start, length });
      }
    } catch {
      return []; // no local variable table (release/optimized)
    }

    const inScope = slots.filter((s) => index >= s.start && index < s.start + BigInt(s.length));
    if (inScope.length === 0) return [];

    // request values for the in-scope slots
    const w = this.w().threadID(threadId).frameID(frameId).int(inScope.length);
    for (const s of inScope) w.int(s.slot).byte(s.sig.charCodeAt(0));
    const vdata = await this.req(CommandSet.StackFrame, StackFrameCmd.GetValues, w.build());
    const vr = this.r(vdata);
    const vcount = vr.int();
    const out: Local[] = [];
    for (let i = 0; i < vcount && i < inScope.length; i++) {
      const dv = decodeByTag(vr.byte(), vr);
      out.push({
        name: inScope[i].name,
        type: prettyTypeSignature(inScope[i].sig),
        value: renderValue(dv),
        objectId: dv.objectId && dv.objectId !== "0" ? dv.objectId : undefined,
        tag: dv.tag,
      });
    }
    return out;
  }

  // ---------- stepping ----------

  async step(threadId: bigint, action: "OVER" | "INTO" | "OUT"): Promise<number> {
    const w = this.w()
      .byte(EventKind.SINGLE_STEP)
      .byte(SuspendPolicy.EVENT_THREAD)
      .int(1)
      .byte(ModifierKind.Step)
      .threadID(threadId)
      .int(STEP_SIZE_LINE)
      .int(STEP_DEPTH[action]);
    const data = await this.req(CommandSet.EventRequest, EventRequestCmd.Set, w.build());
    const requestId = this.r(data).int();
    await this.session.resume();
    return requestId;
  }

  async resume(): Promise<void> {
    await this.session.resume();
  }
}

function renderValue(dv: DecodedValue): string {
  if (dv.kind === "null") return "null";
  if (dv.kind === "string") return `String@${dv.objectId}`;
  if (dv.kind === "array") return `array@${dv.objectId}`;
  if (dv.kind === "object") return `${dv.tag}@${dv.objectId}`;
  return String(dv.value);
}
