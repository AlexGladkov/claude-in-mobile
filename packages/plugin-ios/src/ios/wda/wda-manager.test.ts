import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WDAManager } from "./wda-manager.js";
import type { WDAClient } from "./wda-client.js";

interface TestInstance {
  pid: number | undefined;
  port: number;
  deviceId: string;
  child: ChildProcess;
  generation: symbol;
}

interface ManagerHarness {
  instances: Map<string, TestInstance>;
  clients: Map<string, WDAClient>;
  reservePort(): Promise<number>;
  publishInstance(deviceId: string, port: number, child: ChildProcess): TestInstance;
}

function harness(manager: WDAManager): ManagerHarness {
  return manager as unknown as ManagerHarness;
}

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(function (this: ChildProcess, signal = "SIGTERM") {
      Object.assign(this, { signalCode: signal });
      this.emit("exit", null, signal);
      return true;
    }),
  });
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WDAManager ownership", () => {
  it("reserves different ports across manager instances", async () => {
    const first = new WDAManager();
    const second = new WDAManager();
    const firstPort = await harness(first).reservePort();
    const secondPort = await harness(second).reservePort();
    const firstChild = fakeChild(10_001);
    const secondChild = fakeChild(10_002);
    harness(first).instances.set("a", {
      pid: firstChild.pid,
      port: firstPort,
      deviceId: "a",
      child: firstChild,
      generation: Symbol("a"),
    });
    harness(second).instances.set("b", {
      pid: secondChild.pid,
      port: secondPort,
      deviceId: "b",
      child: secondChild,
      generation: Symbol("b"),
    });

    expect(secondPort).not.toBe(firstPort);

    await Promise.all([first.cleanup(), second.cleanup()]);
  });

  it("reuses the live instance's actual port", async () => {
    const manager = new WDAManager();
    const child = fakeChild(10_003);
    harness(manager).publishInstance("device-a", 8_177, child);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sessionId: "session-a" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = await manager.ensureWDAReady("device-a");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8177/session");
    expect(manager.isClientActive("device-a", client)).toBe(true);
    child.emit("exit", 0, null);
    expect(manager.isClientActive("device-a", client)).toBe(false);
    await manager.cleanup();
  });

  it("tears down a reused process when session creation fails", async () => {
    const manager = new WDAManager();
    const child = fakeChild(10_006);
    harness(manager).instances.set("device-a", {
      pid: child.pid,
      port: 8_178,
      deviceId: "device-a",
      child,
      generation: Symbol("device-a"),
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("WDA unavailable"));

    await expect(manager.ensureWDAReady("device-a")).rejects.toThrow("WDA unavailable");

    expect(harness(manager).instances.has("device-a")).toBe(false);
    expect(child.kill).toHaveBeenCalled();
    await manager.cleanup();
  });

  it("terminates tracked processes before awaiting session deletion", async () => {
    const manager = new WDAManager();
    const child = fakeChild(10_007);
    harness(manager).instances.set("device-a", {
      pid: child.pid,
      port: 8_179,
      deviceId: "device-a",
      child,
      generation: Symbol("device-a"),
    });
    let releaseDelete: (() => void) | undefined;
    const deleting = new Promise<void>((resolve) => { releaseDelete = resolve; });
    harness(manager).clients.set("other-device", {
      deleteSession: vi.fn(() => deleting),
    } as unknown as WDAClient);

    const cleanup = manager.cleanup();
    await Promise.resolve();

    expect(child.kill).toHaveBeenCalled();
    releaseDelete?.();
    await cleanup;
  });

  it("ignores exit events from an old process generation", () => {
    const manager = new WDAManager();
    const oldChild = fakeChild(10_004);
    const currentChild = fakeChild(10_005);
    const publish = harness(manager).publishInstance.bind(manager);
    const oldInstance = publish("device-a", 8_110, oldChild);
    const currentInstance = publish("device-a", 8_111, currentChild);

    oldChild.emit("exit", 1, null);

    expect(harness(manager).instances.get("device-a")).toBe(currentInstance);
    expect(harness(manager).instances.get("device-a")).not.toBe(oldInstance);
  });
});
