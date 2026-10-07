import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IosClient } from "./client.js";
import { WDAManager } from "./wda/wda-manager.js";
import type { WDAClient } from "./wda/wda-client.js";

interface ClientHarness {
  wdaClient?: WDAClient & { sessionId: string | null };
  ensureWDA(deviceIdOverride?: string): Promise<WDAClient>;
}

interface ManagerHarness {
  publishInstance(deviceId: string, port: number, child: ChildProcess): unknown;
}

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { pid, exitCode: null, signalCode: null, kill: vi.fn(() => true) });
  return child;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IosClient session lifetime", () => {
  it("recreates an evicted session once across concurrent client calls", async () => {
    const manager = new WDAManager();
    (manager as unknown as ManagerHarness).publishInstance("device-a", 8_181, fakeChild(20_001));
    const client = new IosClient("device-a", manager);
    const harness = client as unknown as ClientHarness;

    let created = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (method === "POST" && url.endsWith("/session")) {
        created += 1;
        return jsonResponse({ sessionId: `session-${created}` });
      }
      // WDA has evicted the session it handed out earlier.
      if (method === "GET" && url.includes("/session/")) {
        return new Response("invalid session id", { status: 404 });
      }
      return jsonResponse({ value: {} });
    });

    await harness.ensureWDA();
    expect(harness.wdaClient?.sessionId).toBe("session-1");

    await Promise.all([harness.ensureWDA(), harness.ensureWDA()]);

    expect(created).toBe(2);
    expect(harness.wdaClient?.sessionId).toBe("session-2");
    await manager.cleanup();
  });

  it("refreshes cached point dimensions after the selected device changes", async () => {
    const manager = new WDAManager();
    (manager as unknown as ManagerHarness).publishInstance("device-a", 8_181, fakeChild(20_001));
    (manager as unknown as ManagerHarness).publishInstance("device-b", 8_182, fakeChild(20_002));
    const client = new IosClient("device-a", manager);
    let windowRequests = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (method === "POST" && url.endsWith("/session")) {
        return jsonResponse({ sessionId: url.includes(":8181") ? "session-a" : "session-b" });
      }
      if (url.endsWith("/window/size")) {
        windowRequests += 1;
        return jsonResponse({
          value: url.includes(":8181")
            ? { width: 390, height: 844 }
            : { width: 430, height: 932 },
        });
      }
      return jsonResponse({ value: {} });
    });

    await expect(client.getScreenPointSize()).resolves.toEqual({ width: 390, height: 844 });
    await expect(client.getScreenPointSize()).resolves.toEqual({ width: 390, height: 844 });
    client.setDevice("device-b");
    await expect(client.getScreenPointSize()).resolves.toEqual({ width: 430, height: 932 });

    expect(windowRequests).toBe(2);
    await manager.cleanup();
  });
});

describe("IosClient Home key", () => {
  it("goes home through WDA, so a headless simulator needs no Simulator.app", async () => {
    const client = new IosClient("device-a", new WDAManager());
    const pressHome = vi.fn().mockResolvedValue(undefined);
    const ensureWDA = vi
      .spyOn(client as unknown as ClientHarness, "ensureWDA")
      .mockResolvedValue({ pressHome } as unknown as WDAClient);

    await client.pressKey("HOME", "device-b");

    expect(ensureWDA).toHaveBeenCalledWith("device-b");
    expect(pressHome).toHaveBeenCalledOnce();
  });
});
