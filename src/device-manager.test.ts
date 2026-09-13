import { describe, expect, it, vi } from "vitest";

import type { CorePlatformAdapter } from "./adapters/platform-adapter.js";
import { DeviceManager } from "./device-manager.js";
import type { Platform } from "./platform-types.js";

function disposableAdapter(
  platform: Platform,
  dispose: () => void | Promise<void>,
): CorePlatformAdapter {
  return {
    platform,
    dispose,
    getSelectedDeviceId: () => undefined,
    autoDetectDevice: () => undefined,
  } as unknown as CorePlatformAdapter;
}

describe("DeviceManager adapter ownership", () => {
  it("disposes each owned adapter identity once across repeated cleanup", async () => {
    const dispose = vi.fn(async () => {});
    const adapter = disposableAdapter("android", dispose);
    const manager = new DeviceManager({
      adapters: new Map<Platform, CorePlatformAdapter>([
        ["android", adapter],
        ["ios", adapter],
      ]),
    });

    await Promise.all([manager.cleanup(), manager.cleanup()]);
    await manager.cleanup();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("continues disposing owned adapters after one disposal fails", async () => {
    const error = new Error("cleanup failed");
    const failingDispose = vi.fn(async () => { throw error; });
    const succeedingDispose = vi.fn(async () => {});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = new DeviceManager({
      adapters: new Map<Platform, CorePlatformAdapter>([
        ["android", disposableAdapter("android", failingDispose)],
        ["ios", disposableAdapter("ios", succeedingDispose)],
      ]),
    });

    await manager.cleanup();

    expect(failingDispose).toHaveBeenCalledOnce();
    expect(succeedingDispose).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("Failed to dispose 'android' adapter:", "cleanup failed");
    log.mockRestore();
  });

  it("does not dispose adapters owned by the plugin kernel", async () => {
    const dispose = vi.fn(async () => {});
    const adapter = disposableAdapter("android", dispose);
    const manager = DeviceManager.fromKernel({
      registry: {
        list: () => [{
          state: "active" as const,
          plugin: { manifest: { id: "android" }, adapter },
        }],
      },
    });

    await manager.cleanup();

    expect(dispose).not.toHaveBeenCalled();
    expect(manager.getAdapter("android")).toBe(adapter);
  });

  it("routes a plugin adapter by its public platform id", () => {
    const adapter = disposableAdapter("browser", vi.fn());
    const manager = DeviceManager.fromKernel({
      registry: {
        list: () => [{
          state: "active" as const,
          plugin: { manifest: { id: "web" }, adapter },
        }],
      },
    });

    expect(manager.getAdapter("browser")).toBe(adapter);
  });

  it("does not expose adapters from failed plugins", () => {
    const adapter = disposableAdapter("android", vi.fn());
    const manager = DeviceManager.fromKernel({
      registry: {
        list: () => [{
          state: "failed" as const,
          plugin: { manifest: { id: "android" }, adapter },
        }],
      },
    });

    expect(() => manager.getAdapter("android")).toThrow("Platform 'android' is not installed");
  });
});
