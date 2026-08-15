import { describe, it, expect } from "vitest";
import { JdwpReader, JdwpWriter, encodeCommand, HEADER_LEN, type IdSizes } from "./packet.js";

const SIZES: IdSizes = {
  fieldIDSize: 8,
  methodIDSize: 8,
  objectIDSize: 8,
  referenceTypeIDSize: 8,
  frameIDSize: 8,
};

describe("JdwpWriter / JdwpReader round-trip", () => {
  it("round-trips primitives (incl. negatives)", () => {
    const buf = new JdwpWriter()
      .byte(0xab)
      .boolean(true)
      .int(-12345)
      .int(2147483647)
      .long(-1n)
      .string("héllo·世界")
      .build();

    const r = new JdwpReader(buf);
    expect(r.byte()).toBe(0xab);
    expect(r.boolean()).toBe(true);
    expect(r.int()).toBe(-12345);
    expect(r.int()).toBe(2147483647);
    expect(r.long()).toBe(-1n);
    expect(r.string()).toBe("héllo·世界");
    expect(r.remaining).toBe(0);
  });

  it("round-trips 8-byte ids beyond Number.MAX_SAFE_INTEGER (bigint precision)", () => {
    const big = 0x0123_4567_89ab_cdefn; // > 2^53
    const buf = new JdwpWriter(SIZES).objectID(big).methodID(42n).build();
    const r = new JdwpReader(buf, SIZES);
    expect(r.objectID()).toBe(big);
    expect(r.methodID()).toBe(42n);
  });

  it("respects variable id sizes (4-byte)", () => {
    const sizes: IdSizes = { ...SIZES, objectIDSize: 4 };
    const buf = new JdwpWriter(sizes).objectID(0xdeadbeefn).build();
    expect(buf.length).toBe(4);
    expect(new JdwpReader(buf, sizes).objectID()).toBe(0xdeadbeefn);
  });

  it("round-trips a location (typeTag + classID + methodID + index)", () => {
    const buf = new JdwpWriter(SIZES).location(1, 0x1111n, 0x2222n, 99n).build();
    const loc = new JdwpReader(buf, SIZES).location();
    expect(loc).toEqual({ typeTag: 1, classID: 0x1111n, methodID: 0x2222n, index: 99n });
  });
});

describe("encodeCommand framing", () => {
  it("writes an 11-byte header with length, id, flags=0, set, cmd + payload", () => {
    const payload = Buffer.from([0x01, 0x02, 0x03]);
    const pkt = encodeCommand(7, 1, 7, payload);

    expect(pkt.readUInt32BE(0)).toBe(HEADER_LEN + payload.length);
    expect(pkt.readUInt32BE(4)).toBe(7); // id
    expect(pkt.readUInt8(8)).toBe(0); // flags = command
    expect(pkt.readUInt8(9)).toBe(1); // commandSet
    expect(pkt.readUInt8(10)).toBe(7); // command
    expect(pkt.subarray(HEADER_LEN)).toEqual(payload);
  });

  it("handles an empty payload", () => {
    const pkt = encodeCommand(1, 1, 1, Buffer.alloc(0));
    expect(pkt.length).toBe(HEADER_LEN);
    expect(pkt.readUInt32BE(0)).toBe(HEADER_LEN);
  });
});
