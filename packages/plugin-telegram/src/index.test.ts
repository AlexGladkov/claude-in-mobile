import { describe, expect, it } from "vitest";
import { ALL_CAPABILITIES } from "@mcp-devices/plugin-api";

import createTelegramPlugin, {
  TELEGRAM_PLUGIN_MANIFEST,
  TelegramPlugin,
  TelegramAdapter,
} from "./index.js";

describe("telegram plugin manifest", () => {
  it("declares the telegram platform id and v1 api", () => {
    expect(TELEGRAM_PLUGIN_MANIFEST.id).toBe("telegram");
    expect(TELEGRAM_PLUGIN_MANIFEST.apiVersion).toBe("1");
    expect(TELEGRAM_PLUGIN_MANIFEST.version).toBe("4.0.0-dev");
  });

  it("only declares capabilities from the public capability set", () => {
    for (const cap of TELEGRAM_PLUGIN_MANIFEST.capabilities) {
      expect(ALL_CAPABILITIES).toContain(cap);
    }
    expect(TELEGRAM_PLUGIN_MANIFEST.capabilities).toEqual(
      expect.arrayContaining(["ui", "input", "deviceMgmt"]),
    );
    // v1 does not claim screen capture.
    expect(TELEGRAM_PLUGIN_MANIFEST.capabilities).not.toContain("screen");
  });
});

describe("telegram plugin wiring", () => {
  it("exposes a telegram adapter the kernel bridge can pick up", () => {
    const plugin = createTelegramPlugin();
    expect(plugin.manifest.id).toBe("telegram");
    // adaptersFromKernel reads `plugin.adapter`.
    const adapter = (plugin as TelegramPlugin).adapter;
    expect(adapter).toBeInstanceOf(TelegramAdapter);
    expect(adapter.platform).toBe("telegram");
  });

  it("init does not throw", () => {
    const plugin = createTelegramPlugin();
    const ctx = {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      config: {},
      eventBus: { emit() {}, on: () => () => {} },
      registerTool() {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => plugin.init(ctx as any)).not.toThrow();
  });
});

describe("telegram adapter unsupported surface", () => {
  it("throws for spatial gestures and v1 screen capture", async () => {
    const adapter = new TelegramAdapter();
    await expect(adapter.doubleTap()).rejects.toThrow(/not supported/i);
    await expect(adapter.longPress()).rejects.toThrow(/not supported/i);
    await expect(adapter.swipe()).rejects.toThrow(/not supported/i);
    await expect(adapter.swipeDirection()).rejects.toThrow(/not supported/i);
    await expect(adapter.screenshotAsync(true)).rejects.toThrow(/not supported/i);
    await expect(adapter.getScreenshotBufferAsync()).rejects.toThrow(/not supported/i);
  });

  it("treats Enter-like keys as no-ops and rejects others", async () => {
    const adapter = new TelegramAdapter();
    await expect(adapter.pressKey("Enter")).resolves.toBeUndefined();
    await expect(adapter.pressKey("Send")).resolves.toBeUndefined();
    await expect(adapter.pressKey("VolumeUp")).rejects.toThrow(/not supported/i);
  });

  it("reports no synthetic device until a bot is configured", () => {
    const adapter = new TelegramAdapter();
    expect(adapter.listDevices()).toEqual([]);
  });

  it("exposes a synthetic device once a bot is configured", () => {
    const adapter = new TelegramAdapter({
      config: { sessionId: "test-dc-smoke", botUsername: "@my_bot" },
    });
    const devices = adapter.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      platform: "telegram",
      name: "@my_bot",
      isSimulator: true,
    });
  });
});
