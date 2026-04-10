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

describe("SonicWsClient enhanced message handling", () => {
  it("sendAndCollectList() collects items until done message", async () => {
    wss.on("connection", ws => {
      ws.on("message", () => {
        // Simulate streaming app list responses
        ws.send(JSON.stringify({ msg: "appListDetail", detail: { appName: "TestApp", packageName: "com.test.app" } }));
        ws.send(JSON.stringify({ msg: "appListDetail", detail: { appName: "AnotherApp", packageName: "com.another.app" } }));
        ws.send(JSON.stringify({ msg: "appListFinish" }));
      });
    });

    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    const result = await client.sendAndCollectList<{ appName: string; packageName: string }>(
      { type: "appList" },
      "appListDetail",
      "appListFinish",
      5000
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ appName: "TestApp", packageName: "com.test.app" });
    expect(result[1]).toEqual({ appName: "AnotherApp", packageName: "com.another.app" });
    client.disconnect();
  });

  it("sendAndCollectList() rejects on timeout", async () => {
    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    await expect(
      client.sendAndCollectList({ type: "appList" }, "appListDetail", "appListFinish", 100)
    ).rejects.toThrow("timeout");
    client.disconnect();
  });

  it("sendAndCollectListWithTimeout() collects items and resolves after timeout", async () => {
    wss.on("connection", ws => {
      ws.on("message", () => {
        // Simulate streaming responses without done message (Android behavior)
        ws.send(JSON.stringify({ msg: "appListDetail", detail: { appName: "App1", packageName: "com.app1" } }));
        ws.send(JSON.stringify({ msg: "appListDetail", detail: { appName: "App2", packageName: "com.app2" } }));
      });
    });

    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    const result = await client.sendAndCollectListWithTimeout<{ appName: string; packageName: string }>(
      { type: "appList" },
      "appListDetail",
      200
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ appName: "App1", packageName: "com.app1" });
    expect(result[1]).toEqual({ appName: "App2", packageName: "com.app2" });
    client.disconnect();
  });

  it("sendAndCollectListWithTimeout() returns empty array if no messages", async () => {
    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    const result = await client.sendAndCollectListWithTimeout(
      { type: "appList" },
      "appListDetail",
      100
    );

    expect(result).toEqual([]);
    client.disconnect();
  });

  it("sendAndWaitWithError() resolves on expected message", async () => {
    wss.on("connection", ws => {
      ws.on("message", () => {
        ws.send(JSON.stringify({ msg: "openDriver", status: "success", width: 390, height: 844 }));
      });
    });

    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    const result = await client.sendAndWaitWithError(
      { type: "debug", detail: "openDriver" },
      "openDriver",
      "error",
      5000
    );

    expect(result).toMatchObject({ msg: "openDriver", status: "success" });
    client.disconnect();
  });

  it("sendAndWaitWithError() rejects on error message", async () => {
    wss.on("connection", ws => {
      ws.on("message", () => {
        ws.send(JSON.stringify({ msg: "error", error: "Driver not initialized" }));
      });
    });

    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    await expect(
      client.sendAndWaitWithError(
        { type: "debug", detail: "openDriver" },
        "openDriver",
        "error",
        5000
      )
    ).rejects.toThrow("Driver not initialized");
    client.disconnect();
  });

  it("sendAndWaitWithError() rejects on timeout", async () => {
    const client = new SonicWsClient();
    await client.connect(`ws://localhost:${port}`);
    await expect(
      client.sendAndWaitWithError(
        { type: "debug", detail: "openDriver" },
        "openDriver",
        "error",
        100
      )
    ).rejects.toThrow("Timeout waiting for");
    client.disconnect();
  });
});
