import { describe, expect, it } from "vitest";

import { bootstrapKernel, bootstrapKernelAsync } from "./bootstrap.js";
import { DeviceManager } from "../device-manager.js";

const ALL = ["android", "ios", "web", "desktop", "aurora", "harmony"] as const;

describe("bootstrapKernel", () => {
  it("is slim by default — only base plugins, no platforms", () => {
    const k = bootstrapKernel();
    const ids = k.registry.list().map((e) => e.plugin.manifest.id).sort();
    expect(ids).toEqual(["builtin-tools", "repl"]);
  });

  it("loads only the requested platforms (async — platforms are packaged)", async () => {
    const k = await bootstrapKernelAsync({ platforms: ["ios"], toolPlugins: [] });
    const ids = k.registry.list().map((e) => e.plugin.manifest.id).sort();
    expect(ids).toEqual(["builtin-tools", "ios", "repl"]);
  });

  it("sync bootstrap is base-only — all platforms are separate packages", () => {
    const k = bootstrapKernel({ platforms: ALL });
    const ids = k.registry.list().map((e) => e.plugin.manifest.id).sort();
    // Every platform now ships as @mcp-devices/plugin-* and loads only via
    // the async bootstrap (dynamic import).
    expect(ids).toEqual(["builtin-tools", "repl"]);
  });

  it("async bootstrap loads the packaged aurora plugin when installed", async () => {
    const k = await bootstrapKernelAsync({ platforms: ["aurora"] });
    const ids = k.registry.list().map((e) => e.plugin.manifest.id).sort();
    // base is always present; aurora registers iff the workspace package is
    // built + resolvable (it is, in this repo). Degrades gracefully otherwise.
    expect(ids).toContain("builtin-tools");
    expect(ids).toContain("repl");
    expect(ids).toContain("aurora");
  });

  it("async bootstrap loads the packaged HarmonyOS plugin", async () => {
    const k = await bootstrapKernelAsync({ platforms: ["harmony"] });
    await k.initAll();
    expect(k.getPlugin("harmony")?.manifest.id).toBe("harmony");
    expect(k.toolOwners.get("harmony_launch_ability")).toBe("harmony");
    await k.disposeAll();
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

  it("resolves plugins by capability without naming platforms", async () => {
    const k = await bootstrapKernelAsync({ platforms: ALL });
    const screenProviders = k.resolver
      .resolve({ capabilities: ["screen"] })
      .map((p) => p.manifest.id)
      .sort();
    expect(screenProviders).toEqual(
      ["android", "aurora", "desktop", "harmony", "ios", "web"].sort()
    );
    const terminalProviders = k.resolver
      .resolve({ capabilities: ["terminal"] })
      .map((p) => p.manifest.id);
    expect(terminalProviders).toEqual(["repl"]);
  });

  it("exposes permission management on supported mobile platforms", async () => {
    const k = await bootstrapKernelAsync({ platforms: ALL });
    const permProviders = k.resolver
      .resolve({ capabilities: ["permissions"] })
      .map((p) => p.manifest.id)
      .sort();
    expect(permProviders).toEqual(["android", "harmony", "ios"]);
  });

  it("getPlugin returns typed plugin instance", async () => {
    const k = await bootstrapKernelAsync({ platforms: ["android"] });
    const android = k.getPlugin("android");
    expect(android?.manifest.id).toBe("android");
    expect(k.getPlugin("nope")).toBeUndefined();
  });

  it("keeps the first tool owner and rejects a conflicting plugin atomically", async () => {
    const tool = (name: string) => ({
      name,
      description: "",
      inputSchema: {},
      handler: async () => null,
    });
    const k = bootstrapKernel({
      builtins: [
        () => ({
          manifest: {
            id: "owner-a",
            name: "A",
            version: "1.0.0",
            apiVersion: "1",
            capabilities: ["meta-tools"],
          },
          init: (ctx) => { ctx.registerTool(tool("shared")); },
        }),
        () => ({
          manifest: {
            id: "owner-b",
            name: "B",
            version: "1.0.0",
            apiVersion: "1",
            capabilities: ["meta-tools"],
          },
          init: (ctx) => {
            ctx.registerTool(tool("only-b"));
            ctx.registerTool(tool("shared"));
          },
        }),
      ],
    });

    await k.initAll();

    expect(k.registry.get("owner-a")?.state).toBe("active");
    expect(k.registry.get("owner-b")?.state).toBe("failed");
    expect(k.tools.has("shared")).toBe(true);
    expect(k.toolOwners.get("shared")).toBe("owner-a");
    expect(k.tools.has("only-b")).toBe(false);
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
