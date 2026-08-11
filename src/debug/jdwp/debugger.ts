/**
 * JdwpDebugger — the debugging surface on top of a JdwpSession: class/method
 * resolution, breakpoints, an event poll-queue, stack frames + locals, and
 * stepping. Agent-facing model is poll-based (never blocks): set traps, poll a
 * cursor for hits, inspect the paused thread, resume/step.
 */

import type { JdwpSession } from "./session.js";
import type { JdwpConnection } from "./connection.js";
import { JdwpReader, JdwpWriter, type IdSizes } from "./packet.js";
import {
  decodeByTag,
  prettyTypeSignature,
  classNameToSignature,
  writeTaggedValue,
  parseLiteral,
  coerceForSignature,
  type DecodedValue,
  type EncodableValue,
} from "./values.js";
import {
  CommandSet,
  VirtualMachineCmd,
  ReferenceTypeCmd,
  MethodCmd,
  ThreadReferenceCmd,
  EventRequestCmd,
  StackFrameCmd,
  ObjectReferenceCmd,
  StringReferenceCmd,
  ClassTypeCmd,
  InvokeOptions,
  EventKind,
  SuspendPolicy,
  ModifierKind,
  Tag,
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

export interface EvalResult {
  type: string;
  value: string;
  objectId?: string;
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

  // ---------- eval / set-var ----------

  private async stringValue(objectId: bigint): Promise<string> {
    const data = await this.req(
      CommandSet.StringReference,
      StringReferenceCmd.Value,
      this.w().objectID(objectId).build(),
    );
    return this.r(data).string();
  }

  private async renderDecoded(dv: DecodedValue): Promise<EvalResult> {
    if (dv.kind === "string" && dv.objectId && dv.objectId !== "0") {
      const s = await this.stringValue(BigInt(dv.objectId)).catch(() => "");
      return { type: "String", value: JSON.stringify(s), objectId: dv.objectId };
    }
    return {
      type: dv.kind === "primitive" ? dv.tag : dv.kind,
      value: renderValue(dv),
      objectId: dv.objectId && dv.objectId !== "0" ? dv.objectId : undefined,
    };
  }

  private async objectClass(objectId: bigint): Promise<bigint> {
    const data = await this.req(
      CommandSet.ObjectReference,
      ObjectReferenceCmd.ReferenceType,
      this.w().objectID(objectId).build(),
    );
    const r = this.r(data);
    r.byte(); // refTypeTag
    return r.referenceTypeID();
  }

  private async fieldsOf(classID: bigint): Promise<{ fieldID: bigint; name: string; sig: string }[]> {
    const data = await this.req(
      CommandSet.ReferenceType,
      ReferenceTypeCmd.FieldsWithGeneric,
      this.w().referenceTypeID(classID).build(),
    );
    const r = this.r(data);
    const n = r.int();
    const out: { fieldID: bigint; name: string; sig: string }[] = [];
    for (let i = 0; i < n; i++) {
      const fieldID = r.fieldID();
      const name = r.string();
      const sig = r.string();
      r.string(); // generic
      r.int(); // modBits
      out.push({ fieldID, name, sig });
    }
    return out;
  }

  private async createString(s: string): Promise<bigint> {
    const data = await this.req(
      CommandSet.VirtualMachine,
      VirtualMachineCmd.CreateString,
      this.w().string(s).build(),
    );
    return this.r(data).objectID();
  }

  /** Resolve the receiver object for an eval expression (a top-frame local or `this`). */
  private async resolveReceiver(threadId: bigint, name: string): Promise<bigint> {
    const raw = await this.framesRaw(threadId, 1);
    if (raw.length === 0) throw new Error("no stack frame");
    const top = raw[0];
    if (name === "this") {
      const data = await this.req(
        CommandSet.StackFrame,
        3, // ThisObject
        this.w().threadID(threadId).frameID(top.frameId).build(),
      );
      const r = this.r(data);
      const obj = decodeByTag(r.byte(), r);
      if (!obj.objectId || obj.objectId === "0") throw new Error("`this` is null / unavailable");
      return BigInt(obj.objectId);
    }
    const locals = await this.locals(threadId, top.frameId, top.loc.classID, top.loc.methodID, top.loc.index);
    const local = locals.find((l) => l.name === name);
    if (!local?.objectId) throw new Error(`local '${name}' is not an object (or not in scope)`);
    return BigInt(local.objectId);
  }

  private async invokeMethod(
    objectId: bigint,
    threadId: bigint,
    methodName: string,
    argTokens: string[],
  ): Promise<EvalResult> {
    const objClassID = await this.objectClass(objectId);
    // Methods can be inherited — walk up the superclass chain to find the
    // declaring class, and invoke against THAT class type.
    const resolved = await this.resolveMethodInHierarchy(objClassID, methodName, argTokens.length);
    if (!resolved) throw new Error(`no method '${methodName}' on the receiver (or its superclasses)`);
    const { classID, method: chosen } = resolved;

    // Encode args (literals only; strings created in the VM).
    const encoded: EncodableValue[] = [];
    for (const tok of argTokens) {
      const lit = parseLiteral(tok);
      if (!lit) throw new Error(`unsupported argument literal: ${tok}`);
      if (lit.tag === Tag.STRING && lit.str !== undefined) {
        encoded.push({ tag: Tag.STRING, objectId: await this.createString(lit.str) });
      } else {
        encoded.push(lit);
      }
    }

    const w = this.w()
      .objectID(objectId)
      .threadID(threadId)
      .referenceTypeID(classID)
      .methodID(chosen.methodID)
      .int(encoded.length);
    for (const a of encoded) writeTaggedValue(w, a);
    w.int(InvokeOptions.SINGLE_THREADED);

    const data = await this.req(CommandSet.ObjectReference, ObjectReferenceCmd.InvokeMethod, w.build());
    const r = this.r(data);
    const ret = decodeByTag(r.byte(), r);
    const exc = decodeByTag(r.byte(), r);
    if (exc.objectId && exc.objectId !== "0") {
      return { type: "exception", value: `threw ${exc.tag}@${exc.objectId}`, objectId: exc.objectId };
    }
    return this.renderDecoded(ret);
  }

  private async superclassOf(classID: bigint): Promise<bigint> {
    try {
      const data = await this.req(
        CommandSet.ClassType,
        ClassTypeCmd.Superclass,
        this.w().referenceTypeID(classID).build(),
      );
      return this.r(data).referenceTypeID();
    } catch {
      return 0n;
    }
  }

  /** Find a method by name (and arg count) in a class or any superclass. */
  private async resolveMethodInHierarchy(
    startClassID: bigint,
    methodName: string,
    argCount: number,
  ): Promise<{ classID: bigint; method: MethodInfo } | null> {
    let classID = startClassID;
    for (let hop = 0; hop < 32 && classID !== 0n; hop++) {
      if (!this.methodCache.has(classID.toString())) {
        try {
          await this.methodsOf(classID);
        } catch {
          break;
        }
      }
      const candidates = this.methodCache.get(classID.toString())?.filter((m) => m.name === methodName) ?? [];
      const pick = candidates.find((m) => paramCount(m.signature) === argCount) ?? candidates[0];
      if (pick) return { classID, method: pick };
      classID = await this.superclassOf(classID);
    }
    return null;
  }

  /** Find a field by name in a class or any superclass. */
  private async resolveFieldInHierarchy(
    startClassID: bigint,
    fieldName: string,
  ): Promise<{ classID: bigint; fieldID: bigint } | null> {
    let classID = startClassID;
    for (let hop = 0; hop < 32 && classID !== 0n; hop++) {
      const f = (await this.fieldsOf(classID).catch(() => [])).find((x) => x.name === fieldName);
      if (f) return { classID, fieldID: f.fieldID };
      classID = await this.superclassOf(classID);
    }
    return null;
  }

  private async readField(objectId: bigint, fieldName: string): Promise<EvalResult> {
    const objClassID = await this.objectClass(objectId);
    const f = await this.resolveFieldInHierarchy(objClassID, fieldName);
    if (!f) throw new Error(`no field '${fieldName}' on the receiver (or its superclasses)`);
    const w = this.w().objectID(objectId).int(1).fieldID(f.fieldID);
    const data = await this.req(CommandSet.ObjectReference, ObjectReferenceCmd.GetValues, w.build());
    const r = this.r(data);
    r.int(); // count
    return this.renderDecoded(decodeByTag(r.byte(), r));
  }

  /**
   * Evaluate a small expression against a paused thread. Supported forms:
   *   `name`                → value of a top-frame local (or `this`)
   *   `name.field`          → read an instance field
   *   `name.method(a, b)`   → invoke a method (literal args: int/long/float/bool/null/"str")
   * Full arithmetic/operators are out of scope (use eval on getters + inspect).
   */
  async eval(threadId: bigint, expr: string): Promise<EvalResult> {
    const m = expr.trim().match(/^([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*)(\((.*)\))?)?$/);
    if (!m) throw new Error("unsupported expression (supported: name, name.field, name.method(args))");
    const [, recv, member, callParens, argsStr] = m;

    if (!member) {
      // bare local
      const raw = await this.framesRaw(threadId, 1);
      const top = raw[0];
      const locals = await this.locals(threadId, top.frameId, top.loc.classID, top.loc.methodID, top.loc.index);
      const local = locals.find((l) => l.name === recv);
      if (!local) throw new Error(`local '${recv}' not in scope`);
      if (local.objectId) {
        return this.renderDecoded({ tag: local.tag, kind: "object", value: null, objectId: local.objectId });
      }
      return { type: local.type, value: local.value };
    }

    const objectId = await this.resolveReceiver(threadId, recv);
    if (callParens !== undefined) {
      const args = (argsStr ?? "").trim();
      const tokens = args === "" ? [] : splitArgs(args);
      return this.invokeMethod(objectId, threadId, member, tokens);
    }
    return this.readField(objectId, member);
  }

  /** Set a top-frame local to a new value (primitives + null; strings created in VM). */
  async setVar(threadId: bigint, name: string, rawValue: string): Promise<void> {
    const raw = await this.framesRaw(threadId, 1);
    if (raw.length === 0) throw new Error("no stack frame");
    const top = raw[0];

    // find the slot + signature for the named local from the variable table
    const data = await this.req(
      CommandSet.Method,
      MethodCmd.VariableTableWithGeneric,
      this.w().referenceTypeID(top.loc.classID).methodID(top.loc.methodID).build(),
    );
    const r = this.r(data);
    r.int(); // argCnt
    const n = r.int();
    let target: { slot: number; sig: string } | undefined;
    for (let i = 0; i < n; i++) {
      const start = r.long();
      const vName = r.string();
      const sig = r.string();
      r.string();
      const length = r.int();
      const slot = r.int();
      if (vName === name && top.loc.index >= start && top.loc.index < start + BigInt(length)) {
        target = { slot, sig };
      }
    }
    if (!target) throw new Error(`local '${name}' not found / not in scope`);

    const enc = coerceForSignature(target.sig, rawValue);
    if (enc.tag === Tag.STRING && enc.str !== undefined) {
      enc.objectId = await this.createString(enc.str);
    }
    const w = this.w().threadID(threadId).frameID(top.frameId).int(1).int(target.slot);
    writeTaggedValue(w, enc);
    await this.req(CommandSet.StackFrame, StackFrameCmd.SetValues, w.build());
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

/** Split a call argument list at top-level commas (respects quotes). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of s) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "(" || ch === "[") {
      depth++;
      cur += ch;
    } else if (ch === ")" || ch === "]") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** Count parameters in a JVM method signature "(II)V" etc. */
function paramCount(sig: string): number {
  const inner = sig.slice(sig.indexOf("(") + 1, sig.indexOf(")"));
  let i = 0;
  let count = 0;
  while (i < inner.length) {
    while (inner[i] === "[") i++;
    if (inner[i] === "L") {
      i = inner.indexOf(";", i) + 1;
    } else {
      i++;
    }
    count++;
  }
  return count;
}
