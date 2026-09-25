import { describe, expect, it, vi } from "vitest";

import { AdbClient } from "./client.js";
import { WebViewInspector } from "./webview.js";

class RecordingAdbClient extends AdbClient {
  readonly calls: Array<{ command: string; deviceId?: string }> = [];
  failCleanup = false;

  constructor() {
    super("selected-device");
  }

  override exec(command: string, deviceIdOverride?: string): string {
    this.calls.push({ command, deviceId: deviceIdOverride });
    if (this.failCleanup && command.startsWith("forward --remove")) {
      throw new Error(`failed to remove ${command}`);
    }
    return "00000000: 00000002 00010000 0001 01 12345 @example_devtools_remote\n";
  }
}

describe("WebViewInspector explicit device routing", () => {
  it("uses its fixed device when discovering WebView sockets", () => {
    const client = new RecordingAdbClient();
    const inspector = new WebViewInspector(client, "target-device");

    expect(inspector.discoverWebViews()).toEqual(["example_devtools_remote"]);
    expect(client.calls).toEqual([{
      command: "shell cat /proc/net/unix 2>/dev/null",
      deviceId: "target-device",
    }]);
  });

  it("removes the ADB forward when target discovery fails", async () => {
    const client = new RecordingAdbClient();
    const inspector = new WebViewInspector(client, "target-device");
    vi.spyOn(inspector, "listTargets").mockRejectedValue(new Error("CDP unavailable"));

    await expect(inspector.inspect()).rejects.toThrow("CDP unavailable");
    expect(client.calls).toEqual([
      {
        command: "shell cat /proc/net/unix 2>/dev/null",
        deviceId: "target-device",
      },
      {
        command: expect.stringMatching(/^forward tcp:\d+ localabstract:example_devtools_remote$/),
        deviceId: "target-device",
      },
      {
        command: expect.stringMatching(/^forward --remove tcp:\d+$/),
        deviceId: "target-device",
      },
    ]);
  });

  it("removes the forward before returning inspection and omits the local port", async () => {
    const client = new RecordingAdbClient();
    const inspector = new WebViewInspector(client, "target-device");
    vi.spyOn(inspector, "listTargets").mockResolvedValue([]);

    await expect(inspector.inspect()).resolves.toEqual({
      sockets: ["example_devtools_remote"],
      targets: [],
    });
    expect(client.calls.at(-1)).toEqual({
      command: expect.stringMatching(/^forward --remove tcp:\d+$/),
      deviceId: "target-device",
    });
  });

  it("retains a failed cleanup for an explicit retry without exposing the port", async () => {
    const client = new RecordingAdbClient();
    const inspector = new WebViewInspector(client, "target-device");
    client.failCleanup = true;
    vi.spyOn(inspector, "listTargets").mockResolvedValue([]);

    await expect(inspector.inspect()).rejects.toThrow(/retry cleanup/u);
    expect(client.calls.at(-1)?.command).toMatch(/^forward --remove tcp:\d+$/u);
    expect(() => inspector.cleanup()).toThrow(/retry cleanup/u);
    client.failCleanup = false;
    expect(() => inspector.cleanup()).not.toThrow();
    expect(client.calls.filter(call => call.command.startsWith("forward --remove"))).toHaveLength(3);
  });
});
