import { describe, it, expect } from "vitest";
import { JdwpWriter, type IdSizes } from "./packet.js";
import {
  decodeByTag,
  prettyTypeSignature,
  classNameToSignature,
  parseLiteral,
  coerceForSignature,
  writeTaggedValue,
  tagForSignature,
} from "./values.js";
import { Tag } from "./constants.js";
import { JdwpReader } from "./packet.js";

const SIZES: IdSizes = {
  fieldIDSize: 8, methodIDSize: 8, objectIDSize: 8, referenceTypeIDSize: 8, frameIDSize: 8,
};

function reader(build: (w: JdwpWriter) => void): JdwpReader {
  const w = new JdwpWriter(SIZES);
  build(w);
  return new JdwpReader(w.build(), SIZES);
}

describe("decodeByTag", () => {
  it("decodes INT / BOOLEAN / LONG primitives", () => {
    expect(decodeByTag(Tag.INT, reader((w) => w.int(-7)))).toMatchObject({ kind: "primitive", value: -7, tag: "I" });
    expect(decodeByTag(Tag.BOOLEAN, reader((w) => w.byte(1)))).toMatchObject({ kind: "primitive", value: true });
    expect(decodeByTag(Tag.LONG, reader((w) => w.long(9_000_000_000n)))).toMatchObject({
      kind: "primitive",
      value: 9_000_000_000n,
    });
  });

  it("decodes STRING/ARRAY/OBJECT as object ids", () => {
    expect(decodeByTag(Tag.STRING, reader((w) => w.objectID(42n)))).toMatchObject({ kind: "string", objectId: "42" });
    expect(decodeByTag(Tag.ARRAY, reader((w) => w.objectID(7n)))).toMatchObject({ kind: "array", objectId: "7" });
    expect(decodeByTag(Tag.OBJECT, reader((w) => w.objectID(99n)))).toMatchObject({ kind: "object", objectId: "99" });
  });

  it("treats a null object reference (id 0) as null", () => {
    expect(decodeByTag(Tag.OBJECT, reader((w) => w.objectID(0n)))).toMatchObject({ kind: "null", objectId: "0" });
  });
});

describe("literal parsing + encoding (eval args / set-var)", () => {
  it("parses int/long/float/bool/null/string literals", () => {
    expect(parseLiteral("42")).toMatchObject({ tag: Tag.INT, num: 42 });
    expect(parseLiteral("100L")).toMatchObject({ tag: Tag.LONG, big: 100n });
    expect(parseLiteral("1.5")).toMatchObject({ tag: Tag.DOUBLE, num: 1.5 });
    expect(parseLiteral("1.5f")).toMatchObject({ tag: Tag.FLOAT });
    expect(parseLiteral("true")).toMatchObject({ tag: Tag.BOOLEAN, bool: true });
    expect(parseLiteral("null")).toMatchObject({ tag: Tag.OBJECT, objectId: 0n });
    expect(parseLiteral('"hi"')).toMatchObject({ tag: Tag.STRING, str: "hi" });
    expect(parseLiteral("someLocal")).toBeNull();
  });

  it("maps signatures to tags and coerces set-var values", () => {
    expect(tagForSignature("I")).toBe(Tag.INT);
    expect(tagForSignature("Ljava/lang/String;")).toBe(Tag.OBJECT);
    expect(coerceForSignature("Z", "true")).toMatchObject({ tag: Tag.BOOLEAN, bool: true });
    expect(coerceForSignature("J", "9000000000")).toMatchObject({ tag: Tag.LONG, big: 9_000_000_000n });
  });

  it("round-trips an encoded tagged INT through the decoder", () => {
    const w = new JdwpWriter(SIZES);
    writeTaggedValue(w, { tag: Tag.INT, num: -123 });
    const r = new JdwpReader(w.build(), SIZES);
    expect(decodeByTag(r.byte(), r)).toMatchObject({ kind: "primitive", value: -123 });
  });

  it("round-trips an encoded tagged LONG and BOOLEAN", () => {
    const w = new JdwpWriter(SIZES);
    writeTaggedValue(w, { tag: Tag.LONG, big: 5_000_000_000n });
    writeTaggedValue(w, { tag: Tag.BOOLEAN, bool: true });
    const r = new JdwpReader(w.build(), SIZES);
    expect(decodeByTag(r.byte(), r)).toMatchObject({ value: 5_000_000_000n });
    expect(decodeByTag(r.byte(), r)).toMatchObject({ value: true });
  });
});

describe("type signature helpers", () => {
  it("prettifies object, primitive and array signatures", () => {
    expect(prettyTypeSignature("Lcom/foo/Bar;")).toBe("com.foo.Bar");
    expect(prettyTypeSignature("I")).toBe("int");
    expect(prettyTypeSignature("[I")).toBe("int[]");
    expect(prettyTypeSignature("[[Ljava/lang/String;")).toBe("java.lang.String[][]");
  });

  it("round-trips className -> signature", () => {
    expect(classNameToSignature("com.foo.Bar")).toBe("Lcom/foo/Bar;");
  });
});
