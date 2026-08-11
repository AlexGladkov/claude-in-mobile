/**
 * JDWP tagged-value decoding.
 *
 * Many replies (locals, field values, array elements) carry a value as a
 * tag byte followed by tag-specific bytes. Object-like values decode to an
 * `objectId` the caller can drill into later; primitives decode to JS values.
 */

import { JdwpReader } from "./packet.js";
import { Tag } from "./constants.js";

export interface DecodedValue {
  /** JDWP tag character, e.g. "I", "L", "s". */
  tag: string;
  /** Primitive value (number/boolean/bigint) or null for object/null refs. */
  value: number | boolean | bigint | null;
  /** Present for object-like tags (OBJECT/STRING/ARRAY/THREAD/…). "0" == null ref. */
  objectId?: string;
  /** Coarse kind for the agent-facing schema. */
  kind: "primitive" | "object" | "string" | "array" | "null";
}

const tagChar = (t: number): string => String.fromCharCode(t);

/** Decode a tagged value from a reader positioned at the tag byte. */
export function readTaggedValue(r: JdwpReader): DecodedValue {
  const tag = r.byte();
  return decodeByTag(tag, r);
}

/** Decode a value whose tag is already known (e.g. StackFrame.GetValues echoes the tag). */
export function decodeByTag(tag: number, r: JdwpReader): DecodedValue {
  const ch = tagChar(tag);
  switch (tag) {
    case Tag.BOOLEAN:
      return { tag: ch, value: r.byte() !== 0, kind: "primitive" };
    case Tag.BYTE:
      return { tag: ch, value: (r.byte() << 24) >> 24, kind: "primitive" };
    case Tag.CHAR:
    case Tag.SHORT: {
      const hi = r.byte();
      const lo = r.byte();
      const u = (hi << 8) | lo;
      return { tag: ch, value: tag === Tag.SHORT ? (u << 16) >> 16 : u, kind: "primitive" };
    }
    case Tag.INT:
      return { tag: ch, value: r.int(), kind: "primitive" };
    case Tag.FLOAT: {
      const b = Buffer.alloc(4);
      b.writeInt32BE(r.int(), 0);
      return { tag: ch, value: b.readFloatBE(0), kind: "primitive" };
    }
    case Tag.LONG:
      return { tag: ch, value: r.long(), kind: "primitive" };
    case Tag.DOUBLE: {
      const b = Buffer.alloc(8);
      b.writeBigInt64BE(r.long(), 0);
      return { tag: ch, value: b.readDoubleBE(0), kind: "primitive" };
    }
    case Tag.VOID:
      return { tag: ch, value: null, kind: "null" };
    case Tag.STRING: {
      const id = r.objectID();
      return { tag: ch, value: null, objectId: id.toString(), kind: "string" };
    }
    case Tag.ARRAY: {
      const id = r.objectID();
      return { tag: ch, value: null, objectId: id.toString(), kind: "array" };
    }
    case Tag.OBJECT:
    case Tag.THREAD:
    case Tag.THREAD_GROUP:
    case Tag.CLASS_LOADER:
    case Tag.CLASS_OBJECT: {
      const id = r.objectID();
      return {
        tag: ch,
        value: null,
        objectId: id.toString(),
        kind: id === 0n ? "null" : "object",
      };
    }
    default:
      // Unknown tag → best-effort: treat as an object id so we don't desync.
      return { tag: ch, value: null, objectId: r.objectID().toString(), kind: "object" };
  }
}

/** JVM type signature → readable name, e.g. "Lcom/foo/Bar;" → "com.foo.Bar", "[I" → "int[]". */
export function prettyTypeSignature(sig: string): string {
  let depth = 0;
  let i = 0;
  while (sig[i] === "[") {
    depth++;
    i++;
  }
  const base = sig.slice(i);
  const prims: Record<string, string> = {
    B: "byte", C: "char", D: "double", F: "float",
    I: "int", J: "long", S: "short", Z: "boolean", V: "void",
  };
  let name: string;
  if (base[0] === "L" && base.endsWith(";")) {
    name = base.slice(1, -1).replace(/\//g, ".");
  } else {
    name = prims[base] ?? base;
  }
  return name + "[]".repeat(depth);
}

/** Class name (dotted) → JVM signature "Lcom/foo/Bar;". */
export function classNameToSignature(className: string): string {
  return "L" + className.replace(/\./g, "/") + ";";
}
