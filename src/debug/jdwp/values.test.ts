import { describe, it, expect } from "vitest";
import { JdwpWriter, type IdSizes } from "./packet.js";
import { decodeByTag, prettyTypeSignature, classNameToSignature } from "./values.js";
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
