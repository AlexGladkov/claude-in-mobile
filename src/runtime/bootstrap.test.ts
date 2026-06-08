import { describe, expect, it } from "vitest";

import { bootstrapKernel } from "./bootstrap.js";
import { DeviceManager } from "../device-manager.js";

describe("bootstrapKernel", () => {
  it("registers all 7 built-in plugins", () => {
    const k = bootstrapKernel();
    const ids = k.registry.list().map((e) => e.plugin.manifest.id).sort();
    expect(ids).toEqual([
      "android",
      "aurora",
      "builtin-tools",
      "desktop",
      "ios",
      "repl",
      "web",
    ]);
  });

  it("initializes all plugins to active state", async () => {
    const k = bootstrapKernel();
    await k.initAll();
    for (const entry of k.registry.list()) {
      expect(entry.state).toBe("active");
    }
  });

  it("disposeAll transitions to disposed and is idempotent", async () => {
    const k = bootstrapKernel();
    await k.initAll();
    await k.disposeAll();
    await k.disposeAll();
    for (const entry of k.registry.list()) {
      expect(entry.state).toBe("disposed");
    }
  });

  it("resolves plugins by capability without naming platforms", () => {
    const k = bootstrapKernel();
    const screenProviders = k.resolver
      .resolve({ capabilities: ["screen"] })
      .map((p) => p.manifest.id)
      .sort();
    expect(screenProviders).toEqual(
      ["android", "aurora", "desktop", "ios", "web"].sort()
    );
    const terminalProviders = k.resolver
      .resolve({ capabilities: ["terminal"] })
      .map((p) => p.manifest.id);
    expect(terminalProviders).toEqual(["repl"]);
  });

  it("only browser/desktop have NO permissions capability", () => {
    const k = bootstrapKernel();
    const permProviders = k.resolver
      .resolve({ capabilities: ["permissions"] })
      .map((p) => p.manifest.id)
      .sort();
    expect(permProviders).toEqual(["android", "ios"]);
  });

  it("getPlugin returns typed plugin instance", () => {
    const k = bootstrapKernel();
    const android = k.getPlugin("android");
    expect(android?.manifest.id).toBe("android");
    expect(k.getPlugin("nope")).toBeUndefined();
  });
});

describe("DeviceManager.fromKernel", () => {
  it("builds a DeviceManager from kernel registry adapters", () => {
    const k = bootstrapKernel();
    const dm = DeviceManager.fromKernel(k);
    expect(dm).toBeInstanceOf(DeviceManager);
  });

  it("respects an explicit active target", () => {
    const k = bootstrapKernel();
    const dm = DeviceManager.fromKernel(k, "ios");
    const t = dm.getTarget();
    expect(t.target).toBe("ios");
  });
});
