/**
 * JDWP (Java Debug Wire Protocol) constants.
 *
 * We speak JDWP directly over an `adb forward tcp:<port> jdwp:<pid>` socket —
 * the same approach a JVM debugger (or Android Studio) uses — so an agent can
 * inspect a live, *debuggable* Android app (breakpoints, locals, eval, step)
 * without any GUI or JVM-side helper. This is a from-scratch TS implementation
 * of the wire protocol; it does not depend on JDI/JVM.
 *
 * Spec: https://docs.oracle.com/javase/8/docs/platform/jpda/jdwp/jdwp-protocol.html
 */

export const JDWP_HANDSHAKE = "JDWP-Handshake";

/** Reply packet flag (bit set in the header `flags` byte). */
export const FLAG_REPLY = 0x80;

/** Command sets and commands we use (extend as capabilities grow). */
export const CommandSet = {
  VirtualMachine: 1,
  ReferenceType: 2,
  ClassType: 3,
  Method: 6,
  ObjectReference: 9,
  StringReference: 10,
  ThreadReference: 11,
  EventRequest: 15,
  StackFrame: 16,
  Event: 64,
} as const;

export const VirtualMachineCmd = {
  Version: 1,
  ClassesBySignature: 2,
  AllThreads: 4,
  Dispose: 6,
  IDSizes: 7,
  Suspend: 8,
  Resume: 9,
  Capabilities: 17,
} as const;

export const ReferenceTypeCmd = {
  MethodsWithGeneric: 15,
  SourceFile: 7,
} as const;

export const MethodCmd = {
  LineTable: 1,
  VariableTableWithGeneric: 5,
} as const;

export const ThreadReferenceCmd = {
  Name: 1,
  Frames: 6,
  FrameCount: 7,
  Status: 4,
} as const;

export const EventRequestCmd = {
  Set: 1,
  Clear: 2,
} as const;

export const StackFrameCmd = {
  GetValues: 1,
} as const;

/** JDWP EventKind (used in EventRequest.Set and incoming Event.Composite). */
export const EventKind = {
  SINGLE_STEP: 1,
  BREAKPOINT: 2,
  METHOD_ENTRY: 40,
  METHOD_EXIT: 41,
  EXCEPTION: 4,
  CLASS_PREPARE: 8,
  THREAD_START: 6,
  THREAD_DEATH: 7,
  VM_DEATH: 99,
} as const;

/** SuspendPolicy for event requests. */
export const SuspendPolicy = {
  NONE: 0,
  EVENT_THREAD: 1,
  ALL: 2,
} as const;

/** EventRequest modifier kinds. */
export const ModifierKind = {
  Count: 1,
  ClassOnly: 4,
  ClassMatch: 5,
  LocationOnly: 7,
  Step: 10,
} as const;

/** JDWP value/type tag bytes. */
export const Tag = {
  ARRAY: 91, // '['
  BYTE: 66, // 'B'
  CHAR: 67, // 'C'
  OBJECT: 76, // 'L'
  FLOAT: 70, // 'F'
  DOUBLE: 68, // 'D'
  INT: 73, // 'I'
  LONG: 74, // 'J'
  SHORT: 83, // 'S'
  VOID: 86, // 'V'
  BOOLEAN: 90, // 'Z'
  STRING: 115, // 's'
  THREAD: 116, // 't'
  THREAD_GROUP: 103, // 'g'
  CLASS_LOADER: 108, // 'l'
  CLASS_OBJECT: 99, // 'c'
} as const;

export const TypeTag = {
  CLASS: 1,
  INTERFACE: 2,
  ARRAY: 3,
} as const;

/** Human-readable names for the JDWP error codes we are most likely to hit. */
export const JdwpError: Record<number, string> = {
  10: "INVALID_THREAD",
  13: "THREAD_NOT_SUSPENDED",
  20: "INVALID_OBJECT",
  21: "INVALID_CLASS",
  23: "INVALID_METHODID",
  25: "INVALID_LOCATION",
  30: "INVALID_FRAMEID",
  31: "NO_MORE_FRAMES",
  35: "ABSENT_INFORMATION",
  99: "NOT_IMPLEMENTED",
  103: "INVALID_TAG",
  112: "INVALID_SLOT",
  502: "INVALID_EVENT_TYPE",
};
