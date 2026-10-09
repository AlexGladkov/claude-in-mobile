import { describe, expect, it } from "vitest";
import type { Device } from "../device-manager.js";
import { resolveDevice } from "./device-resolver.js";

const device = (id: string, platform: Device["platform"], state = "connected"): Device => ({
  id, name: id, platform, state, isSimulator: false,
});

describe("device resolver platform compatibility", () => {
  it("preserves legacy exact-ID matching before platform fallback", () => {
    const ios = device("shared-id", "ios");
    const android = device("android-id", "android");
    expect(resolveDevice("shared-id", "android", { devices: [ios, android], errors: [] }).device).toBe(ios);
  });

  it.each(["android", "ios", "harmony", "desktop", "browser"] as const)(
    "preserves connected-device fallback on %s",
    (platform) => {
      const target = device("available", platform);
      expect(resolveDevice("missing", platform, { devices: [target], errors: [] }).device).toBe(target);
    },
  );

  it("requires an exact Aurora ID even when another platform has the same ID", () => {
    const android = device("phone", "android");
    const aurora = device("phone", "aurora", "unknown");
    expect(resolveDevice("phone", "aurora", { devices: [android, aurora], errors: [] }).device).toBe(aurora);
    expect(() => resolveDevice("phone", "aurora", { devices: [android], errors: [] })).toThrow(/phone/);
    expect(() => resolveDevice("typo", "aurora", { devices: [aurora], errors: [] })).toThrow(/typo/);
  });
});
