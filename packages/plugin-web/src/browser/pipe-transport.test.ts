import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { MAX_PIPE_MESSAGE_BYTES, PipeCdpClient } from "./pipe-transport.js";

function frame(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\u0000`);
}

describe("PipeCdpClient", () => {
  it("uses the private pipe, attaches a page target, and routes CDP commands", async () => {
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const requests: Array<Record<string, unknown>> = [];

    outgoing.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8").replace(/\u0000$/, "")) as Record<string, unknown>;
      requests.push(request);
      const result = request.method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "page-1", type: "page" }] }
        : request.method === "Target.attachToTarget"
          ? { sessionId: "session-1" }
          : request.method === "Runtime.evaluate" || request.method === "Runtime.callFunctionOn"
            ? { result: { type: "number", value: 2 } }
            : {};
      incoming.write(frame({ id: request.id, result }));
    });

    const cdp = await PipeCdpClient.connect({ incoming, outgoing });
    await cdp.Page.enable();
    await cdp.Runtime.enable();
    await expect(cdp.Runtime.evaluate({ expression: "1 + 1", returnByValue: true }))
      .resolves.toEqual({ result: { type: "number", value: 2 } });
    await expect(cdp.Runtime.callFunctionOn({
      objectId: "object-1",
      functionDeclaration: "function() { return 2; }",
      returnByValue: true,
    })).resolves.toEqual({ result: { type: "number", value: 2 } });

    expect(requests.slice(0, 3)).toEqual([
      { id: 1, method: "Target.getTargets", params: {} },
      { id: 2, method: "Target.attachToTarget", params: { targetId: "page-1", flatten: true } },
      { id: 3, method: "Page.enable", params: {}, sessionId: "session-1" },
    ]);
    expect(requests.slice(3, 6)).toEqual([
      { id: 4, method: "Runtime.enable", params: {}, sessionId: "session-1" },
      {
        id: 5,
        method: "Runtime.evaluate",
        params: { expression: "1 + 1", returnByValue: true },
        sessionId: "session-1",
      },
      {
        id: 6,
        method: "Runtime.callFunctionOn",
        params: {
          objectId: "object-1",
          functionDeclaration: "function() { return 2; }",
          returnByValue: true,
        },
        sessionId: "session-1",
      },
    ]);
    expect(outgoing.readableEnded).toBe(false);

    let resolveLoaded!: () => void;
    const loaded = new Promise<void>((resolve) => {
      resolveLoaded = resolve;
    });
    const unsubscribe = cdp.Page.loadEventFired(() => resolveLoaded());
    incoming.write(frame({
      method: "Page.loadEventFired",
      params: { timestamp: 1 },
      sessionId: "session-1",
    }));
    await expect(loaded).resolves.toBeUndefined();
    expect(cdp.listenerCount("Page.loadEventFired")).toBe(1);
    unsubscribe();
    expect(cdp.listenerCount("Page.loadEventFired")).toBe(0);

    await cdp.close();
    expect(requests.at(-1)).toMatchObject({
      method: "Target.detachFromTarget",
      params: { sessionId: "session-1" },
    });
    expect(outgoing.writableEnded).toBe(true);
  });

  it("accepts large valid response frames without quadratic buffer growth", async () => {
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const screenshotData = "A".repeat(8 * 1024 * 1024);

    outgoing.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8").replace(/\u0000$/, "")) as Record<string, unknown>;
      const result = request.method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "page-1", type: "page" }] }
        : request.method === "Target.attachToTarget"
          ? { sessionId: "session-1" }
          : request.method === "Page.captureScreenshot"
            ? { data: screenshotData }
            : {};
      incoming.write(frame({ id: request.id, result }));
    });

    const cdp = await PipeCdpClient.connect({ incoming, outgoing });
    await expect(cdp.Page.captureScreenshot({ format: "png" }))
      .resolves.toEqual({ data: screenshotData });
    await cdp.close();
  });

  it("caps Chrome DevTools frames at 32 MiB", () => {
    expect(MAX_PIPE_MESSAGE_BYTES).toBe(32 * 1024 * 1024);
  });

  it("rejects an oversized unterminated frame before retaining it", async () => {
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    outgoing.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8").replace(/\u0000$/, "")) as Record<string, unknown>;
      const result = request.method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "page-1", type: "page" }] }
        : request.method === "Target.attachToTarget"
          ? { sessionId: "session-1" }
          : {};
      incoming.write(frame({ id: request.id, result }));
    });

    const cdp = await PipeCdpClient.connect({ incoming, outgoing });
    const disconnected = new Promise<Error>((resolve) => {
      cdp.once("disconnect", resolve);
    });
    incoming.write(Buffer.alloc(MAX_PIPE_MESSAGE_BYTES + 1, 0x20));
    await expect(disconnected).resolves.toMatchObject({
      message: expect.stringContaining("size limit"),
    });
  });

  it("rejects pending commands when the private pipe returns malformed data", async () => {
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    outgoing.on("data", () => {});

    const cdpPromise = PipeCdpClient.connect({ incoming, outgoing });
    incoming.write(Buffer.from("not-json\u0000"));

    await expect(cdpPromise).rejects.toThrow("invalid JSON");
    expect(outgoing.writableEnded).toBe(true);
  });
});
