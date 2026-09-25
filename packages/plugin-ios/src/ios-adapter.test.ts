import { describe, expect, it, vi } from "vitest";

import { IosAdapter } from "./ios-adapter.js";
import { IosClient } from "./ios/client.js";
import { IosPlugin } from "./index.js";
import type { WDAClient } from "./ios/wda/wda-client.js";
import type { WDAManager } from "./ios/wda/wda-manager.js";

interface IosClientHarness {
  ensureWDA(deviceIdOverride?: string): Promise<WDAClient>;
}

describe("iOS client ownership", () => {
  it("caches per-device clients created from the shared base client", () => {
    const scoped = new Map<string, IosClient>();
    const base = {
      getDeviceId: () => undefined,
      forDevice: vi.fn((deviceId: string) => {
        const client = { deviceId } as unknown as IosClient;
        scoped.set(deviceId, client);
        return client;
      }),
      cleanup: vi.fn(async () => {}),
    } as unknown as IosClient;
    const adapter = new IosAdapter(base);

    const first = adapter.getClient("device-a");
    const again = adapter.getClient("device-a");
    const second = adapter.getClient("device-b");

    expect(first).toBe(again);
    expect(second).not.toBe(first);
    expect(base.forDevice).toHaveBeenCalledTimes(2);
  });

  it("reacquires WDA after the cached process generation exits", async () => {
    const firstWda = {} as WDAClient;
    const secondWda = {} as WDAClient;
    let active = true;
    const manager = {
      isClientActive: vi.fn(() => active),
      ensureWDAReady: vi.fn(async () => active ? firstWda : secondWda),
    } as unknown as WDAManager;
    const client = new IosClient("device-a", manager);
    const clientHarness = client as unknown as IosClientHarness;

    expect(await clientHarness.ensureWDA()).toBe(firstWda);
    active = false;
    expect(await clientHarness.ensureWDA()).toBe(secondWda);
    expect(manager.ensureWDAReady).toHaveBeenCalledTimes(2);
  });

  it("disposes the shared manager once across repeated calls", async () => {
    const cleanup = vi.fn(async () => {});
    const base = {
      getDeviceId: () => undefined,
      forDevice: (deviceId: string) => ({ deviceId }) as unknown as IosClient,
      cleanup,
    } as unknown as IosClient;
    const adapter = new IosAdapter(base);

    await Promise.all([adapter.dispose(), adapter.dispose()]);

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("delegates plugin disposal", async () => {
    const adapter = { dispose: vi.fn(async () => {}) } as unknown as IosAdapter;

    await new IosPlugin(adapter).dispose();

    expect(adapter.dispose).toHaveBeenCalledOnce();
  });
});

describe("iOS log package filtering", () => {
  const makeClient = () => {
    const getLogs = vi.fn(() => "logs");
    const client = {
      getDeviceId: () => undefined,
      getLogs,
    } as unknown as IosClient;
    return { client, getLogs };
  };

  it("passes a valid reverse-DNS package as one subsystem predicate", () => {
    const { client, getLogs } = makeClient();
    const adapter = new IosAdapter(client);

    expect(adapter.getLogs({ package: "com.example.app" })).toBe("logs");
    expect(getLogs).toHaveBeenCalledOnce();
    expect(getLogs).toHaveBeenCalledWith({
      level: undefined,
      lines: undefined,
      predicate: 'subsystem == "com.example.app"',
    }, undefined);
  });

  it("rejects predicate injection before the client receives a log query", () => {
    const { client, getLogs } = makeClient();
    const adapter = new IosAdapter(client);
    const maliciousPackage = 'foo" OR message CONTAINS[c] "secret';

    expect(() => adapter.getLogs({ package: maliciousPackage })).toThrow();
    expect(getLogs).not.toHaveBeenCalled();
  });
});
