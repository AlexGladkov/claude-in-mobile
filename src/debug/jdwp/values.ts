/**
 * JDWP tagged-value decoding.
 *
 * Many replies (locals, field values, array elements) carry a value as a
 * tag byte followed by tag-specific bytes. Object-like values decode to an
 * `objectId` the caller can drill into later; primitives decode to JS values.
 */

import { JdwpReader, type JdwpWriter } from "./packet.js";
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

/** Map a first signature char to its primitive JDWP tag (or OBJECT for L/[). */
export function tagForSignature(sig: string): number {
  const c = sig[0];
  const map: Record<string, number> = {
    B: Tag.BYTE, C: Tag.CHAR, D: Tag.DOUBLE, F: Tag.FLOAT,
    I: Tag.INT, J: Tag.LONG, S: Tag.SHORT, Z: Tag.BOOLEAN,
  };
  return map[c] ?? Tag.OBJECT;
}

/** A primitive/object literal parsed from an eval argument or set-var value. */
export interface EncodableValue {
  tag: number;
  num?: number;
  big?: bigint;
  bool?: boolean;
  objectId?: bigint; // for OBJECT (incl. null=0 and created strings)
}

/**
 * Parse a simple literal: integers (`10`, `100L`), floats (`1.5`, `1.5f`),
 * booleans, `null`, and quoted strings (`"hi"`). Strings return tag STRING with
 * the raw text in `str` so the caller can create a VM string. Returns null if
 * the token is not a recognised literal (e.g. a local-name reference).
 */
export function parseLiteral(token: string): (EncodableValue & { str?: string }) | null {
  const t = token.trim();
  if (t === "null") return { tag: Tag.OBJECT, objectId: 0n };
  if (t === "true") return { tag: Tag.BOOLEAN, bool: true };
  if (t === "false") return { tag: Tag.BOOLEAN, bool: false };
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return { tag: Tag.STRING, str: t.slice(1, -1) };
  }
  if (/^-?\d+[lL]$/.test(t)) return { tag: Tag.LONG, big: BigInt(t.slice(0, -1)) };
  if (/^-?\d+$/.test(t)) return { tag: Tag.INT, num: parseInt(t, 10) };
  if (/^-?\d*\.\d+[fF]?$/.test(t)) return { tag: /[fF]$/.test(t) ? Tag.FLOAT : Tag.DOUBLE, num: parseFloat(t) };
  return null;
}

/** Coerce a raw string to an EncodableValue for a known slot signature (set-var). */
export function coerceForSignature(sig: string, raw: string): EncodableValue & { str?: string } {
  const tag = tagForSignature(sig);
  const t = raw.trim();
  switch (tag) {
    case Tag.BOOLEAN: return { tag, bool: t === "true" || t === "1" };
    case Tag.LONG: return { tag, big: BigInt(t.replace(/[lL]$/, "")) };
    case Tag.INT: case Tag.SHORT: case Tag.BYTE: case Tag.CHAR: return { tag, num: parseInt(t, 10) };
    case Tag.FLOAT: case Tag.DOUBLE: return { tag, num: parseFloat(t) };
    default:
      if (t === "null") return { tag: Tag.OBJECT, objectId: 0n };
      if (t.startsWith('"') && t.endsWith('"')) return { tag: Tag.STRING, str: t.slice(1, -1) };
      return { tag: Tag.STRING, str: t }; // best-effort: treat as string
  }
}

/** Write a TAGGED value (tag byte + untagged payload). objectId 0 == null. */
export function writeTaggedValue(w: JdwpWriter, v: EncodableValue): void {
  w.byte(v.tag);
  writeUntagged(w, v);
}

function writeUntagged(w: JdwpWriter, v: EncodableValue): void {
  switch (v.tag) {
    case Tag.BOOLEAN: w.byte(v.bool ? 1 : 0); break;
    case Tag.BYTE: w.byte(v.num ?? 0); break;
    case Tag.SHORT: case Tag.CHAR: {
      const n = v.num ?? 0;
      w.byte((n >> 8) & 0xff).byte(n & 0xff);
      break;
    }
    case Tag.INT: w.int(v.num ?? 0); break;
    case Tag.LONG: w.long(v.big ?? 0n); break;
    case Tag.FLOAT: {
      const b = Buffer.alloc(4); b.writeFloatBE(v.num ?? 0, 0); w.int(b.readInt32BE(0)); break;
    }
    case Tag.DOUBLE: {
      const b = Buffer.alloc(8); b.writeDoubleBE(v.num ?? 0, 0); w.long(b.readBigInt64BE(0)); break;
    }
    default: // object-like
      w.objectID(v.objectId ?? 0n);
  }
}
