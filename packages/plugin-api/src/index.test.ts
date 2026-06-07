import { describe, expect, it } from "vitest";
import {
  ALL_CAPABILITIES,
  ApiVersionMismatchError,
  CapabilityMissingError,
  PLUGIN_API_VERSION,
  PluginContractError,
  hasCapability,
  isCapability,
  type PluginManifest,
} from "./index.js";

describe("plugin-api v1 contract", () => {
  it("exposes apiVersion === '1'", () => {
    expect(PLUGIN_API_VERSION).toBe("1");
  });

  it("ALL_CAPABILITIES is exhaustive and unique", () => {
    expect(new Set(ALL_CAPABILITIES).size).toBe(ALL_CAPABILITIES.length);
    expect(ALL_CAPABILITIES).toContain("terminal");
    expect(ALL_CAPABILITIES).toContain("screen");
  });

  it("isCapability accepts known strings", () => {
    expect(isCapability("terminal")).toBe(true);
    expect(isCapability("screen")).toBe(true);
    expect(isCapability("nope")).toBe(false);
    expect(isCapability(42)).toBe(false);
  });

  it("hasCapability checks manifest declaration", () => {
    const m: PluginManifest = {
      id: "repl",
      name: "REPL",
      version: "0.1.0",
      apiVersion: "1",
      capabilities: ["terminal", "input"],
    };
    expect(hasCapability(m, "terminal")).toBe(true);
    expect(hasCapability(m, "screen")).toBe(false);
  });

  describe("errors", () => {
    it("PluginContractError prefixes plugin id", () => {
      const e = new PluginContractError("boom", "android");
      expect(e.message).toBe("[plugin:android] boom");
      expect(e.pluginId).toBe("android");
    });

    it("CapabilityMissingError formats capability", () => {
      const e = new CapabilityMissingError("ios", "shell");
      expect(e.message).toContain("shell");
      expect(e.pluginId).toBe("ios");
    });

    it("ApiVersionMismatchError reports versions", () => {
      const e = new ApiVersionMismatchError("x", "2", "1");
      expect(e.message).toContain('apiVersion="2"');
      expect(e.message).toContain('"1"');
    });
  });
});
