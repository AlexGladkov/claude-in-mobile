/**
 * JDWP packet framing + typed reader/writer.
 *
 * All JDWP data is big-endian. Object/thread/reference/method/field/frame IDs
 * are variable-width (negotiated once via VirtualMachine.IDSizes) — on ART they
 * are typically 8 bytes, which can exceed Number.MAX_SAFE_INTEGER, so every ID
 * is modelled as a `bigint`.
 */

export interface IdSizes {
  fieldIDSize: number;
  methodIDSize: number;
  objectIDSize: number;
  referenceTypeIDSize: number;
  frameIDSize: number;
}

/** Header is 11 bytes: length(4) id(4) flags(1) [+ set(1) cmd(1) | + errorCode(2)]. */
export const HEADER_LEN = 11;

export interface CommandPacket {
  id: number;
  commandSet: number;
  command: number;
  data: Buffer;
}

export interface ReplyPacket {
  id: number;
  errorCode: number;
  data: Buffer;
}

/** Encode a command packet (adds the 11-byte header + set/cmd bytes). */
export function encodeCommand(id: number, commandSet: number, command: number, data: Buffer): Buffer {
  const length = HEADER_LEN + data.length;
  const buf = Buffer.allocUnsafe(length);
  buf.writeUInt32BE(length, 0);
  buf.writeUInt32BE(id, 4);
  buf.writeUInt8(0, 8); // flags = 0 (command)
  buf.writeUInt8(commandSet, 9);
  buf.writeUInt8(command, 10);
  data.copy(buf, HEADER_LEN);
  return buf;
}

/** Sequential big-endian writer for JDWP payloads. */
export class JdwpWriter {
  private chunks: Buffer[] = [];

  constructor(private readonly idSizes?: IdSizes) {}

  byte(v: number): this {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(v & 0xff, 0);
    this.chunks.push(b);
    return this;
  }

  boolean(v: boolean): this {
    return this.byte(v ? 1 : 0);
  }

  int(v: number): this {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32BE(v | 0, 0);
    this.chunks.push(b);
    return this;
  }

  long(v: bigint): this {
    const b = Buffer.allocUnsafe(8);
    b.writeBigInt64BE(BigInt.asIntN(64, v), 0);
    this.chunks.push(b);
    return this;
  }

  string(v: string): this {
    const bytes = Buffer.from(v, "utf8");
    this.int(bytes.length);
    this.chunks.push(bytes);
    return this;
  }

  /** Write a variable-width JDWP id. */
  id(v: bigint, size: number): this {
    const b = Buffer.allocUnsafe(size);
    // Big-endian, right-aligned.
    let x = BigInt.asUintN(size * 8, v);
    for (let i = size - 1; i >= 0; i--) {
      b.writeUInt8(Number(x & 0xffn), i);
      x >>= 8n;
    }
    this.chunks.push(b);
    return this;
  }

  objectID(v: bigint): this {
    return this.id(v, this.sizes().objectIDSize);
  }
  threadID(v: bigint): this {
    return this.id(v, this.sizes().objectIDSize);
  }
  referenceTypeID(v: bigint): this {
    return this.id(v, this.sizes().referenceTypeIDSize);
  }
  methodID(v: bigint): this {
    return this.id(v, this.sizes().methodIDSize);
  }
  fieldID(v: bigint): this {
    return this.id(v, this.sizes().fieldIDSize);
  }
  frameID(v: bigint): this {
    return this.id(v, this.sizes().frameIDSize);
  }

  /** typeTag(byte) + classID + methodID + index(8). */
  location(typeTag: number, classID: bigint, methodID: bigint, index: bigint): this {
    return this.byte(typeTag).referenceTypeID(classID).methodID(methodID).long(index);
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }

  private sizes(): IdSizes {
    if (!this.idSizes) throw new Error("JdwpWriter: idSizes required for id fields");
    return this.idSizes;
  }
}

/** Sequential big-endian reader for JDWP payloads. */
export class JdwpReader {
  private off = 0;

  constructor(private readonly buf: Buffer, private readonly idSizes?: IdSizes) {}

  get remaining(): number {
    return this.buf.length - this.off;
  }

  byte(): number {
    return this.buf.readUInt8(this.off++);
  }

  boolean(): boolean {
    return this.byte() !== 0;
  }

  int(): number {
    const v = this.buf.readInt32BE(this.off);
    this.off += 4;
    return v;
  }

  long(): bigint {
    const v = this.buf.readBigInt64BE(this.off);
    this.off += 8;
    return v;
  }

  string(): string {
    const len = this.int();
    const s = this.buf.toString("utf8", this.off, this.off + len);
    this.off += len;
    return s;
  }

  id(size: number): bigint {
    let v = 0n;
    for (let i = 0; i < size; i++) {
      v = (v << 8n) | BigInt(this.buf.readUInt8(this.off++));
    }
    return v;
  }

  objectID(): bigint {
    return this.id(this.sizes().objectIDSize);
  }
  threadID(): bigint {
    return this.id(this.sizes().objectIDSize);
  }
  referenceTypeID(): bigint {
    return this.id(this.sizes().referenceTypeIDSize);
  }
  methodID(): bigint {
    return this.id(this.sizes().methodIDSize);
  }
  fieldID(): bigint {
    return this.id(this.sizes().fieldIDSize);
  }
  frameID(): bigint {
    return this.id(this.sizes().frameIDSize);
  }

  /** typeTag(byte) + classID + methodID + index(8). */
  location(): { typeTag: number; classID: bigint; methodID: bigint; index: bigint } {
    return {
      typeTag: this.byte(),
      classID: this.referenceTypeID(),
      methodID: this.methodID(),
      index: this.long(),
    };
  }

  private sizes(): IdSizes {
    if (!this.idSizes) throw new Error("JdwpReader: idSizes required for id fields");
    return this.idSizes;
  }
}
