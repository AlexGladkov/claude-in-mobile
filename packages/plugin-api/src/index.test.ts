import { describe, expect, it } from "vitest";
import {
  ALL_PLUGIN_PERMISSIONS,
  ALL_CAPABILITIES,
  ApiVersionMismatchError,
  CapabilityMissingError,
  PLUGIN_API_VERSION,
  PluginContractError,
  hasCapability,
  isCapability,
  isPluginPermission,
} from "./index.js";
import type {
  PluginAppLifecycleAdapter,
  PluginFileTransferAdapter,
  PluginLogsAdapter,
  PluginPermissionsAdapter,
  PluginShellAdapter,
  PluginUiProvider,
  PluginUrlAdapter,
  PluginManifest,
} from "./index.js";

describe("plugin-api v1 contract", () => {
  it("exposes apiVersion === '1'", () => {
    expect(PLUGIN_API_VERSION).toBe("1");
  });

  it("ALL_CAPABILITIES is exhaustive and unique", () => {
    expect(new Set(ALL_CAPABILITIES).size).toBe(ALL_CAPABILITIES.length);
    expect(ALL_CAPABILITIES).toContain("terminal");
    expect(ALL_CAPABILITIES).toContain("screen");
    expect(ALL_CAPABILITIES).toContain("url");
  });

  it("isCapability accepts known strings", () => {
    expect(isCapability("terminal")).toBe(true);
    expect(isCapability("screen")).toBe(true);
    expect(isCapability("url")).toBe(true);
    expect(isCapability("nope")).toBe(false);
    expect(isCapability(42)).toBe(false);
  });

  it("exposes bounded external plugin permissions", () => {
    expect(new Set(ALL_PLUGIN_PERMISSIONS).size).toBe(ALL_PLUGIN_PERMISSIONS.length);
    expect(isPluginPermission("network")).toBe(true);
    expect(isPluginPermission("shell:root")).toBe(false);
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
  it("exposes independently usable capability contracts", async () => {
    const shell: PluginShellAdapter = { shell: () => "ok" };
    const logs: PluginLogsAdapter = {
      getLogs: () => "logs",
      clearLogs: () => "cleared",
    };
    const apps: PluginAppLifecycleAdapter = {
      launchApp: () => "launched",
      stopApp: () => {},
      installApp: () => "installed",
    };
    const permissions: PluginPermissionsAdapter = {
      grantPermission: () => "granted",
      revokePermission: () => "revoked",
      resetPermissions: () => "reset",
    };
    const files: PluginFileTransferAdapter = {
      pushFile: async () => "pushed",
      pullFile: async () => "pulled",
    };
    const url: PluginUrlAdapter = { openUrl: () => "opened" };
    const ui: PluginUiProvider = {
      getUiElements: async () => [{ id: "button", role: "button", text: "OK" }],
    };

    expect(shell.shell("echo ok")).toBe("ok");
    expect(logs.getLogs({})).toBe("logs");
    expect(apps.launchApp("example")).toBe("launched");
    expect(permissions.grantPermission("example", "camera")).toBe("granted");
    await expect(files.pushFile("/tmp/a", "/data/a")).resolves.toBe("pushed");
    expect(url.openUrl("https://example.com")).toBe("opened");
    await expect(ui.getUiElements()).resolves.toEqual([
      { id: "button", role: "button", text: "OK" },
    ]);
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
