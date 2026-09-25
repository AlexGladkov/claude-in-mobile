import { describe, expect, it, vi } from "vitest";

import type { PluginPlatformAdapter } from "@mcp-devices/plugin-api";
import type { CorePlatformAdapter } from "./adapters/platform-adapter.js";
import { DeviceManager } from "./device-manager.js";
import type { Platform } from "./platform-types.js";

function disposableAdapter(
  platform: Platform,
  dispose: () => void | Promise<void>,
): CorePlatformAdapter {
  let selectedDeviceId: string | undefined;
  return {
    platform,
    dispose,
    listDevices: () => [],
    selectDevice(deviceId: string) {
      selectedDeviceId = deviceId;
    },
    getSelectedDeviceId: () => selectedDeviceId,
    autoDetectDevice: () => undefined,
    tap: async () => {},
    doubleTap: async () => {},
    longPress: async () => {},
    swipe: async () => {},
    swipeDirection: async () => {},
    inputText: async () => {},
    pressKey: async () => {},
    screenshotAsync: async () => ({ data: "", mimeType: "image/png" }),
    getScreenshotBufferAsync: async () => Buffer.alloc(0),
    getUiHierarchy: async () => "",
    getUiElements: async () => [],
    getSystemInfo: async () => "",
  } as unknown as CorePlatformAdapter;
}

describe("public DeviceManager construction", () => {
  it("preserves no-argument construction as an empty manager", () => {
    const manager = new DeviceManager();

    expect(() => manager.getAdapter("android")).toThrow(/not installed/u);
  });
});

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

  it("routes an external adapter without UI methods when UI is not advertised", async () => {
    const adapter = disposableAdapter("headless", vi.fn());
    delete adapter.getUiHierarchy;
    delete adapter.getUiElements;
    const manager = DeviceManager.fromKernel({
      registry: {
        list: () => [{
          state: "active" as const,
          plugin: {
            manifest: { id: "headless", capabilities: ["screen", "input"] },
            adapter: adapter as unknown as PluginPlatformAdapter,
          },
        }],
      },
    });

    expect(manager.getAdapter("headless")).toBe(adapter);
    await expect(manager.getUiHierarchy("headless")).rejects.toThrow(
      "Raw UI hierarchy is not supported for headless.",
    );
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
  it("rejects duplicate active plugin adapter platform ids", () => {
    const first = disposableAdapter("tizen", vi.fn());
    const second = disposableAdapter("tizen", vi.fn());

    expect(() => DeviceManager.fromKernel({
      registry: {
        list: () => [
          {
            state: "active" as const,
            plugin: {
              manifest: { id: "tizen-one" },
              adapter: first as unknown as PluginPlatformAdapter,
            },
          },
          {
            state: "active" as const,
            plugin: {
              manifest: { id: "tizen-two" },
              adapter: second as unknown as PluginPlatformAdapter,
            },
          },
        ],
      },
    })).toThrow("Duplicate active plugin adapter platform 'tizen'");
  });

  it("rejects malformed active plugin adapter platform ids", () => {
    const adapter = disposableAdapter("Tizen" as Platform, vi.fn());

    expect(() => DeviceManager.fromKernel({
      registry: {
        list: () => [{
          state: "active" as const,
          plugin: {
            manifest: { id: "tizen-plugin" },
            adapter: adapter as unknown as PluginPlatformAdapter,
          },
        }],
      },
    })).toThrow("Invalid plugin adapter platform 'Tizen'");
  });

  it("routes and selects an external platform adapter by its declared id", () => {
    const adapter = disposableAdapter("tizen", vi.fn());
    const devices = [{
      id: "tizen-1",
      name: "Tizen TV",
      platform: "tizen" as const,
      state: "connected",
      isSimulator: false,
    }];
    Object.assign(adapter, { listDevices: () => devices });

    const manager = DeviceManager.fromKernel({
      registry: {
        list: () => [{
          state: "active" as const,
          plugin: {
            manifest: { id: "tizen-plugin" },
            adapter: adapter as unknown as PluginPlatformAdapter,
          },
        }],
      },
    });

    expect(manager.getCurrentPlatform()).toBe("tizen");

    expect(manager.getAdapter("tizen")).toBe(adapter);
    expect(manager.getDevices("tizen")).toEqual(devices);
    manager.setTarget("tizen");
    expect(manager.getTarget().target).toBe("tizen");
    expect(() => manager.setTarget("missing-platform")).toThrow(
      "Platform 'missing-platform' is not installed",
    );
    expect(() => manager.setDevice("tizen-1", "missing-platform")).toThrow(
      "Platform 'missing-platform' is not installed",
    );
  });
  it("constrains an explicit platform to the exact device id", () => {
    const androidDevice = {
      id: "shared",
      name: "Android",
      platform: "android" as const,
      state: "device",
      isSimulator: false,
    };
    const iosDevice = {
      id: "shared",
      name: "iOS",
      platform: "ios" as const,
      state: "connected",
      isSimulator: false,
    };
    const androidAdapter = Object.assign(
      disposableAdapter("android", vi.fn()),
      { listDevices: () => [androidDevice] },
    );
    const iosAdapter = Object.assign(
      disposableAdapter("ios", vi.fn()),
      { listDevices: () => [iosDevice] },
    );
    const manager = new DeviceManager({
      adapters: new Map<Platform, CorePlatformAdapter>([
        ["android", androidAdapter],
        ["ios", iosAdapter],
      ]),
      ownsAdapters: false,
    });

    expect(manager.setDevice("shared", "ios")).toEqual(iosDevice);
    expect(manager.getTarget().target).toBe("ios");
  });

  it("rejects a platform mismatch instead of selecting a different device", () => {
    const androidDevice = {
      id: "shared",
      name: "Android",
      platform: "android" as const,
      state: "device",
      isSimulator: false,
    };
    const manager = new DeviceManager({
      adapters: new Map<Platform, CorePlatformAdapter>([
        ["android", Object.assign(disposableAdapter("android", vi.fn()), {
          listDevices: () => [androidDevice],
        })],
        ["ios", disposableAdapter("ios", vi.fn())],
      ]),
      ownsAdapters: false,
    });

    expect(() => manager.setDevice("shared", "ios")).toThrow("Device not found: shared");
    expect(manager.getCurrentPlatform()).toBe("android");
  });

  it("rejects ambiguous device ids when no platform is specified", () => {
    const makeDevice = (platform: "android" | "ios") => ({
      id: "shared",
      name: platform,
      platform,
      state: "connected",
      isSimulator: false,
    });
    const manager = new DeviceManager({
      adapters: new Map<Platform, CorePlatformAdapter>([
        ["android", Object.assign(disposableAdapter("android", vi.fn()), {
          listDevices: () => [makeDevice("android")],
        })],
        ["ios", Object.assign(disposableAdapter("ios", vi.fn()), {
          listDevices: () => [makeDevice("ios")],
        })],
      ]),
      ownsAdapters: false,
    });

    expect(() => manager.setDevice("shared")).toThrow(
      "Device ID 'shared' is ambiguous across platforms; specify platform",
    );
  });
  it("rejects a non-desktop device id when desktop is requested", () => {
    const androidDevice = {
      id: "android-1",
      name: "Android",
      platform: "android" as const,
      state: "device",
      isSimulator: false,
    };
    const manager = new DeviceManager({
      adapters: new Map<Platform, CorePlatformAdapter>([
        ["android", Object.assign(disposableAdapter("android", vi.fn()), {
          listDevices: () => [androidDevice],
        })],
      ]),
      ownsAdapters: false,
    });

    expect(() => manager.setDevice("android-1", "desktop"))
      .toThrow("Device not found: android-1");
    expect(manager.getCurrentPlatform()).toBe("android");
  });


  it("reports and refreshes only the selected target's active device", () => {
    let androidDevice = {
      id: "android-1",
      name: "Android",
      platform: "android",
      state: "device",
      isSimulator: false,
    };
    const androidAdapter = Object.assign(
      disposableAdapter("android", vi.fn()),
      { listDevices: () => [androidDevice] },
    );
    const iosAdapter = Object.assign(
      disposableAdapter("ios", vi.fn()),
      { listDevices: () => [] },
    );
    const manager = new DeviceManager({
      adapters: new Map<Platform, CorePlatformAdapter>([
        ["android", androidAdapter],
        ["ios", iosAdapter],
      ]),
      ownsAdapters: false,
    });

    manager.setDevice("android-1", "android");
    expect(manager.getActiveDevice()).toEqual(androidDevice);
    androidDevice = { ...androidDevice, state: "offline" };
    expect(manager.getActiveDevice()).toEqual(androidDevice);
    expect(manager.getTarget()).toEqual({ target: "android", status: "offline" });
    manager.setTarget("ios");
    expect(manager.getCurrentPlatform()).toBe("ios");
    expect(manager.getTarget()).toEqual({ target: "ios", status: "no device" });
    expect(manager.getActiveDevice()).toBeUndefined();

    manager.setTarget("android");
    expect(manager.getActiveDevice()).toEqual(androidDevice);
  });


  it("derives target device from an adapter's selected id", () => {
    const iosDevices = [
      {
        id: "ios-1",
        name: "iPhone one",
        platform: "ios" as const,
        state: "connected",
        isSimulator: false,
      },
      {
        id: "ios-2",
        name: "iPhone two",
        platform: "ios" as const,
        state: "connected",
        isSimulator: false,
      },
    ];
    const adapter = Object.assign(
      disposableAdapter("ios", vi.fn()),
      { listDevices: () => iosDevices },
    );
    adapter.selectDevice("ios-1");
    const handle = {
      registry: {
        list: () => [{
          state: "active" as const,
          plugin: {
            manifest: { id: "ios-plugin" },
            adapter: adapter as unknown as PluginPlatformAdapter,
          },
        }],
      },
    };
    const manager = DeviceManager.fromKernel(handle);

    expect(manager.getCurrentPlatform()).toBe("ios");
    expect(manager.getTarget()).toEqual({ target: "ios", status: "connected" });
    expect(manager.getActiveDevice()).toEqual(iosDevices[0]);

    adapter.selectDevice("ios-2");
    expect(manager.getActiveDevice()).toEqual(iosDevices[1]);
    expect(manager.getTarget()).toEqual({ target: "ios", status: "connected" });

    const explicitTarget = DeviceManager.fromKernel(handle, "android");
    expect(explicitTarget.getCurrentPlatform()).toBe("android");
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
