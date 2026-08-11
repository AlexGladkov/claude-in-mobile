/**
 * JdwpConnection — the transport: a TCP socket to `adb forward tcp:<port>
 * jdwp:<pid>`, the JDWP handshake, packet framing, request/reply correlation,
 * and delivery of asynchronous VM events (Event.Composite command packets).
 */

import net from "node:net";
import { EventEmitter } from "node:events";
import {
  HEADER_LEN,
  encodeCommand,
  type ReplyPacket,
  type CommandPacket,
} from "./packet.js";
import { JDWP_HANDSHAKE, FLAG_REPLY, CommandSet, JdwpError } from "./constants.js";

export class JdwpProtocolError extends Error {
  constructor(public readonly errorCode: number, context: string) {
    super(`JDWP error ${errorCode} (${JdwpError[errorCode] ?? "UNKNOWN"}) on ${context}`);
    this.name = "JdwpProtocolError";
  }
}

interface Pending {
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
  context: string;
}

/**
 * Emits:
 *  - "event"  (raw Event.Composite command packet) — the session decodes it
 *  - "close"  (socket closed / VM gone)
 *  - "error"  (transport error)
 */
export class JdwpConnection extends EventEmitter {
  private socket?: net.Socket;
  private inbound = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handshaken = false;

  /** Connect to 127.0.0.1:<port> and complete the JDWP handshake. */
  async connect(port: number, timeoutMs = 5000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1");
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`JDWP connect timeout after ${timeoutMs}ms on port ${port}`));
      }, timeoutMs);

      sock.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      sock.once("connect", () => {
        sock.write(JDWP_HANDSHAKE);
      });

      // The very first 14 bytes back must echo the handshake, before any packets.
      const onHandshake = (chunk: Buffer) => {
        this.inbound = Buffer.concat([this.inbound, chunk]);
        if (this.inbound.length < JDWP_HANDSHAKE.length) return;
        const echo = this.inbound.subarray(0, JDWP_HANDSHAKE.length).toString("ascii");
        if (echo !== JDWP_HANDSHAKE) {
          clearTimeout(timer);
          sock.destroy();
          reject(new Error(`Bad JDWP handshake reply: ${JSON.stringify(echo)}`));
          return;
        }
        clearTimeout(timer);
        this.inbound = this.inbound.subarray(JDWP_HANDSHAKE.length);
        this.handshaken = true;
        sock.removeListener("data", onHandshake);
        sock.on("data", (d) => this.onData(d));
        this.socket = sock;
        this.wireLifecycle(sock);
        // Any packet bytes that arrived alongside the handshake echo:
        if (this.inbound.length > 0) this.drainPackets();
        resolve();
      };
      sock.on("data", onHandshake);
    });
  }

  private wireLifecycle(sock: net.Socket): void {
    sock.on("close", () => {
      const err = new Error("JDWP connection closed");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.emit("close");
    });
    sock.on("error", (e) => this.emit("error", e));
  }

  /** Send a command and resolve with the reply payload (throws on JDWP error code). */
  request(commandSet: number, command: number, data: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    if (!this.socket || !this.handshaken) {
      return Promise.reject(new Error("JDWP not connected"));
    }
    const id = this.nextId++;
    const context = `cmd ${commandSet}/${command}`;
    return new Promise<Buffer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, context });
      this.socket!.write(encodeCommand(id, commandSet, command, data), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.inbound = Buffer.concat([this.inbound, chunk]);
    this.drainPackets();
  }

  private drainPackets(): void {
    while (this.inbound.length >= HEADER_LEN) {
      const length = this.inbound.readUInt32BE(0);
      if (length < HEADER_LEN) {
        // Corrupt stream — drop the connection rather than spin.
        this.emit("error", new Error(`Invalid JDWP packet length ${length}`));
        this.socket?.destroy();
        return;
      }
      if (this.inbound.length < length) return; // wait for the rest
      const packet = this.inbound.subarray(0, length);
      this.inbound = this.inbound.subarray(length);
      this.dispatch(packet);
    }
  }

  private dispatch(packet: Buffer): void {
    const id = packet.readUInt32BE(4);
    const flags = packet.readUInt8(8);

    if (flags & FLAG_REPLY) {
      const errorCode = packet.readUInt16BE(9);
      const data = packet.subarray(HEADER_LEN);
      const reply: ReplyPacket = { id, errorCode, data };
      const p = this.pending.get(id);
      if (!p) return; // stray reply
      this.pending.delete(id);
      if (errorCode !== 0) p.reject(new JdwpProtocolError(errorCode, p.context));
      else p.resolve(reply.data);
      return;
    }

    // Command packet from the VM — the only one we expect is Event.Composite.
    const commandSet = packet.readUInt8(9);
    const command = packet.readUInt8(10);
    const cmd: CommandPacket = { id, commandSet, command, data: packet.subarray(HEADER_LEN) };
    if (commandSet === CommandSet.Event) {
      this.emit("event", cmd);
    }
    // (VM never expects a reply to Event.Composite unless suspendPolicy demands it,
    // which the session handles by explicit resume — no auto-reply needed here.)
  }

  get connected(): boolean {
    return this.handshaken && !!this.socket && !this.socket.destroyed;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.handshaken = false;
  }
}
