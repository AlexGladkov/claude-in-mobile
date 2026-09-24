import process from "node:process";
import { Readable, Writable } from "node:stream";

import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

type StdioFraming = "content-length" | "line";

const MAX_BUFFER_SIZE = 10 * 1024 * 1024;
const CONTENT_LENGTH_HEADER = /^content-length:[ \t]*(\d+)[ \t]*$/i;
const CRLF_HEADER_END = Buffer.from("\r\n\r\n");
const LF_HEADER_END = Buffer.from("\n\n");

/**
 * MCP stdio transport compatible with both protocol generations in the wild.
 *
 * Older MCP clients, including OMP 18.x, use HTTP-style Content-Length frames.
 * Newer versions of the TypeScript SDK use newline-delimited JSON. The first
 * incoming frame selects the response framing for the connection.
 */
export class CompatibleStdioServerTransport implements Transport {
  private readonly stdin: Readable;
  private readonly stdout: Writable;
  private buffer = Buffer.alloc(0);
  private started = false;
  private closed = false;
  private framing: StdioFraming | undefined;

  private readonly onData = (chunk: Buffer | string): void => {
    try {
      this.append(chunk);
      this.processBuffer();
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      void this.close();
    }
  };

  private readonly onError = (error: Error): void => {
    this.onerror?.(error);
  };

  public constructor(
    stdin: Readable = process.stdin,
    stdout: Writable = process.stdout,
  ) {
    this.stdin = stdin;
    this.stdout = stdout;
  }

  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  public async start(): Promise<void> {
    if (this.started) {
      throw new Error("CompatibleStdioServerTransport already started");
    }
    if (this.closed) {
      throw new Error("CompatibleStdioServerTransport is closed");
    }

    this.started = true;
    this.stdin.on("data", this.onData);
    this.stdin.on("error", this.onError);
  }

  public async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("Cannot send on a closed stdio transport");
    }

    const json = JSON.stringify(message);
    const payload = this.framing === "content-length"
      ? `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`
      : `${json}\n`;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.stdout.off("drain", onDrain);
        reject(error);
      };
      const onDrain = (): void => {
        this.stdout.off("error", onError);
        resolve();
      };
      this.stdout.once("error", onError);
      if (this.stdout.write(payload, "utf8")) {
        this.stdout.off("error", onError);
        resolve();
      } else {
        this.stdout.once("drain", onDrain);
      }
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stdin.off("data", this.onData);
    this.stdin.off("error", this.onError);
    if (this.stdin.listenerCount("data") === 0) {
      this.stdin.pause();
    }
    this.buffer = Buffer.alloc(0);
    this.onclose?.();
  }

  private append(chunk: Buffer | string): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.buffer.length + next.length > MAX_BUFFER_SIZE) {
      throw new Error(`MCP stdio input exceeds ${MAX_BUFFER_SIZE} bytes`);
    }
    this.buffer = Buffer.concat([this.buffer, next]);
  }

  private processBuffer(): void {
    while (!this.closed) {
      const message = this.readMessage();
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  private readMessage(): JSONRPCMessage | null {
    if (this.framing === undefined) {
      const firstByte = this.firstNonWhitespaceByte();
      if (firstByte === null) return null;
      this.framing = firstByte === 0x43 || firstByte === 0x63
        ? "content-length"
        : "line";
    }

    if (this.framing === "content-length") {
      return this.readContentLengthMessage();
    }
    return this.readLineMessage();
  }

  private readLineMessage(): JSONRPCMessage | null {
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) return null;

      const line = this.buffer.toString("utf8", 0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.trim() === "") continue;
      return JSONRPCMessageSchema.parse(JSON.parse(line));
    }
  }

  private readContentLengthMessage(): JSONRPCMessage | null {
    const headerEnd = this.findHeaderEnd();
    if (headerEnd === null) return null;

    const headerBlock = this.buffer.toString("ascii", 0, headerEnd.headerLength);
    const contentLength = this.parseContentLength(headerBlock);
    const bodyStart = headerEnd.bodyStart;
    if (this.buffer.length - bodyStart < contentLength) return null;

    const body = this.buffer.toString(
      "utf8",
      bodyStart,
      bodyStart + contentLength,
    );
    this.buffer = this.buffer.subarray(bodyStart + contentLength);
    return JSONRPCMessageSchema.parse(JSON.parse(body));
  }

  private findHeaderEnd(): { headerLength: number; bodyStart: number } | null {
    const crlfEnd = this.buffer.indexOf(CRLF_HEADER_END);
    if (crlfEnd !== -1) {
      return { headerLength: crlfEnd, bodyStart: crlfEnd + CRLF_HEADER_END.length };
    }
    const lfEnd = this.buffer.indexOf(LF_HEADER_END);
    if (lfEnd !== -1) {
      return { headerLength: lfEnd, bodyStart: lfEnd + LF_HEADER_END.length };
    }
    return null;
  }

  private parseContentLength(headerBlock: string): number {
    const value = headerBlock
      .split(/\r?\n/)
      .map((line) => line.trim().match(CONTENT_LENGTH_HEADER)?.[1])
      .find((length) => length !== undefined);
    if (value === undefined) {
      throw new Error("MCP stdio frame is missing Content-Length");
    }

    const length = Number(value);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BUFFER_SIZE) {
      throw new Error("MCP stdio Content-Length is invalid");
    }
    return length;
  }

  private firstNonWhitespaceByte(): number | null {
    for (const byte of this.buffer) {
      if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) {
        return byte;
      }
    }
    return null;
  }

}
