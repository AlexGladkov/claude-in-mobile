import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { SonicWsClient } from "./sonic-ws-client.js";

let wss: WebSocketServer;
let port: number;

beforeEach(async () => {
  await new Promise<void>(resolve => {
    wss = new WebSocketServer({ port: 0 }, () => {
      port = (wss.address() as { port: number }).port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>(resolve => wss.close(() => resolve()));
});

describe("SonicWsClient", () => {
  it("connect() opens connection", async () => {
    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    expect(client.isConnected()).toBe(true);
    client.disconnect();
  });

  it("send() delivers JSON message to server", async () => {
    const received: string[] = [];
    wss.on("connection", ws => ws.on("message", d => received.push(d.toString())));

    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    client.send({ type: "debug", detail: "tap", point: "100,200" });
    await new Promise(r => setTimeout(r, 50));
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0])).toMatchObject({ type: "debug", detail: "tap" });
    client.disconnect();
  });

  it("sendAndWait() resolves when expected msg arrives", async () => {
    wss.on("connection", ws => {
      ws.on("message", () => {
        ws.send(JSON.stringify({ msg: "tree", detail: { root: "node" } }));
      });
    });

    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    const result = await client.sendAndWait({ type: "debug", detail: "tree" }, "tree");
    expect(result).toMatchObject({ msg: "tree", detail: { root: "node" } });
    client.disconnect();
  });

  it("sendAndWait() rejects on timeout", async () => {
    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    await expect(
      client.sendAndWait({ type: "debug", detail: "tree" }, "tree", 100)
    ).rejects.toThrow("timeout");
    client.disconnect();
  });

  it("sendForBinary() resolves with binary frame", async () => {
    const imgData = Buffer.from([0xff, 0xd8, 0xff]);
    wss.on("connection", ws => {
      ws.on("message", () => ws.send(imgData));
    });

    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    const buf = await client.sendForBinary({ type: "debug", detail: "screenshot" });
    expect(buf).toEqual(imgData);
    client.disconnect();
  });
});
