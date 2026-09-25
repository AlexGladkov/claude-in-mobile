import type {
  Logger,
  PluginContext,
  SourcePlugin,
  ToolDefinition,
} from "@mcp-devices/plugin-api";
import { ApiVersionMismatchError, PluginContractError } from "@mcp-devices/plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BuiltinPluginLoader,
  CapabilityResolver,
  InMemoryEventBus,
  InMemoryRegistry,
  LifecycleOrchestrator,
  hasAll,
  requireCapability,
} from "./index.js";

function silentLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function makePlugin(
  id: string,
  capabilities: SourcePlugin["manifest"]["capabilities"],
  overrides: Partial<SourcePlugin> = {}
): SourcePlugin {
  return {
    manifest: {
      id,
      name: id,
      version: "0.1.0",
      apiVersion: "1",
      capabilities,
    },
    init: () => {},
    ...overrides,
  };
}

function makeAdapter(dispose: () => void): NonNullable<SourcePlugin["adapter"]> {
  return {
    platform: "test",
    listDevices: () => [],
    selectDevice: () => {},
    getSelectedDeviceId: () => undefined,
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
    getSystemInfo: async () => "",
    dispose,
  };
}

describe("InMemoryRegistry", () => {
  it("registers a valid plugin", () => {
    const r = new InMemoryRegistry();
    r.register(makePlugin("android", ["screen"]));
    expect(r.get("android")?.state).toBe("registered");
    expect(r.list()).toHaveLength(1);
  });
  it("allows adapters without UI methods when they do not advertise UI", () => {
    const registry = new InMemoryRegistry();
    const adapter = makeAdapter(() => {});
    delete adapter.getUiHierarchy;

    registry.register(makePlugin("headless", ["screen", "input"], { adapter }));

    expect(registry.get("headless")?.state).toBe("registered");
  });

  it("rejects duplicate id", () => {
    const r = new InMemoryRegistry();
    r.register(makePlugin("a", ["screen"]));
    expect(() => r.register(makePlugin("a", ["screen"]))).toThrow(PluginContractError);
  });

  it("rejects empty id", () => {
    const r = new InMemoryRegistry();
    expect(() => r.register(makePlugin("", ["screen"]))).toThrow(PluginContractError);
  });

  it("rejects invalid id format", () => {
    const r = new InMemoryRegistry();
    expect(() => r.register(makePlugin("Has Space", ["screen"]))).toThrow(PluginContractError);
  });

  it("rejects mismatched apiVersion", () => {
    const r = new InMemoryRegistry();
    const p = makePlugin("x", ["screen"]);
    (p.manifest as { apiVersion: string }).apiVersion = "2";
    expect(() => r.register(p)).toThrow(ApiVersionMismatchError);
  });

  it("rejects empty capabilities", () => {
    const r = new InMemoryRegistry();
    expect(() => r.register(makePlugin("a", []))).toThrow(PluginContractError);
  });

  it("rejects duplicate capabilities", () => {
    const r = new InMemoryRegistry();
    expect(() =>
      r.register(makePlugin("a", ["screen", "screen"]))
    ).toThrow(PluginContractError);
  });

  it("rejects unknown external permissions", () => {
    const r = new InMemoryRegistry();
    const plugin = makePlugin("a", ["screen"]);
    Object.defineProperty(plugin.manifest, "permissions", { value: ["shell:root"] });
    expect(() => r.register(plugin)).toThrow(PluginContractError);
  });

  it("rejects duplicate external permissions", () => {
    const r = new InMemoryRegistry();
    const plugin = makePlugin("a", ["screen"]);
    Object.defineProperty(plugin.manifest, "permissions", { value: ["network", "network"] });
    expect(() => r.register(plugin)).toThrow(PluginContractError);
  });

  it("freeze blocks further registration", () => {
    const r = new InMemoryRegistry();
    r.freeze();
    expect(() => r.register(makePlugin("a", ["screen"]))).toThrow(PluginContractError);
  });

  it("findByCapability returns matching plugins", () => {
    const r = new InMemoryRegistry();
    r.register(makePlugin("a", ["screen"]));
    r.register(makePlugin("b", ["terminal"]));
    r.register(makePlugin("c", ["screen", "input"]));
    expect(r.findByCapability("screen").map((e) => e.plugin.manifest.id)).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("InMemoryEventBus", () => {
  it("delivers payload to subscribers", () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.on("plugin.registered", (p) => seen.push(p.pluginId));
    bus.emit("plugin.registered", { pluginId: "a" });
    bus.emit("plugin.registered", { pluginId: "b" });
    expect(seen).toEqual(["a", "b"]);
  });

  it("unsubscribe removes handler", () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    const off = bus.on("plugin.registered", (p) => seen.push(p.pluginId));
    bus.emit("plugin.registered", { pluginId: "a" });
    off();
    bus.emit("plugin.registered", { pluginId: "b" });
    expect(seen).toEqual(["a"]);
  });

  it("throwing handler does not break siblings", () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.on("plugin.registered", () => {
      throw new Error("boom");
    });
    bus.on("plugin.registered", (p) => seen.push(p.pluginId));
    bus.emit("plugin.registered", { pluginId: "a" });
    expect(seen).toEqual(["a"]);
  });
});

describe("LifecycleOrchestrator", () => {
  let registry: InMemoryRegistry;
  let bus: InMemoryEventBus;
  let tools: Array<{ pluginId: string; def: ToolDefinition }>;
  let orchestrator: LifecycleOrchestrator;

  beforeEach(() => {
    registry = new InMemoryRegistry();
    bus = new InMemoryEventBus();
    tools = [];
    orchestrator = new LifecycleOrchestrator({
      registry,
      eventBus: bus,
      logger: silentLogger(),
      configFor: () => ({}),
      registerTools: (pluginId, defs) => {
        tools.push(...defs.map((def) => ({ pluginId, def })));
      },
      initTimeoutMs: 200,
      disposeTimeoutMs: 200,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions registered → active on successful init", async () => {
    const p = makePlugin("a", ["screen"], {
      init: (ctx: PluginContext) => {
        ctx.registerTool({
          name: "a.tool",
          description: "",
          inputSchema: {},
          handler: async () => null,
        });
      },
    });
    registry.register(p);
    await orchestrator.initAll();
    expect(registry.get("a")?.state).toBe("active");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.pluginId).toBe("a");
  });

  it("marks plugin failed on init throw, kernel survives", async () => {
    registry.register(
      makePlugin("bad", ["screen"], {
        init: () => {
          throw new Error("nope");
        },
      })
    );
    registry.register(makePlugin("good", ["screen"]));
    await orchestrator.initAll();
    expect(registry.get("bad")?.state).toBe("failed");
    expect(registry.get("bad")?.lastError).toContain("nope");
    expect(registry.get("good")?.state).toBe("active");
  });

  it("init timeout marks failed", async () => {
    vi.useFakeTimers();
    registry.register(
      makePlugin("slow", ["screen"], {
        init: () => new Promise(() => {}),
      })
    );
    const initializing = orchestrator.initAll();
    await vi.advanceTimersByTimeAsync(201);
    await initializing;
    expect(registry.get("slow")?.state).toBe("failed");
    expect(registry.get("slow")?.lastError).toContain("timed out");
  });

  it("dispose is idempotent and called even after failed init", async () => {
    const disposed: string[] = [];
    registry.register(
      makePlugin("a", ["screen"], {
        init: () => {
          throw new Error("x");
        },
        dispose: () => {
          disposed.push("a");
        },
      })
    );
    await orchestrator.initAll();
    await orchestrator.disposeAll();
    await orchestrator.disposeAll();
    expect(disposed).toEqual(["a"]);
    expect(registry.get("a")?.state).toBe("disposed");
  });

  it("falls back to adapter disposal when plugin dispose is absent", async () => {
    let disposed = 0;
    registry.register(makePlugin("adapter-only", ["screen"], {
      adapter: makeAdapter(() => {
        disposed += 1;
      }),
    }));

    await orchestrator.initAll();
    await orchestrator.disposeAll();

    expect(disposed).toBe(1);
    expect(registry.get("adapter-only")?.state).toBe("disposed");
  });

  it("does not commit tools from a failed initialization", async () => {
    registry.register(makePlugin("bad-tools", ["screen"], {
      init: (ctx) => {
        ctx.registerTool({
          name: "bad.tool",
          description: "",
          inputSchema: {},
          handler: async () => null,
        });
        throw new Error("after registration");
      },
    }));

    await orchestrator.initAll();

    expect(tools).toEqual([]);
    expect(registry.get("bad-tools")?.state).toBe("failed");
  });

  it("aborts timed-out init and rejects late registration", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let lateError: unknown;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    registry.register(makePlugin("late", ["screen"], {
      init: async (ctx) => {
        ctx.registerTool({
          name: "early.tool",
          description: "",
          inputSchema: {},
          handler: async () => null,
        });
        await gate;
        try {
          ctx.registerTool({
            name: "late.tool",
            description: "",
            inputSchema: {},
            handler: async () => null,
          });
        } catch (error) {
          lateError = error;
        }
      },
    }));
    const initializing = orchestrator.initAll();
    await vi.advanceTimersByTimeAsync(201);
    await initializing;
    release();
    await Promise.resolve();

    expect(tools).toEqual([]);
    expect(lateError).toBeInstanceOf(Error);
    expect(registry.get("late")?.state).toBe("failed");
  });

  it("waits for timed-out init work to settle before disposal", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let disposed = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    registry.register(makePlugin("timed-out", ["screen"], {
      init: () => gate,
      dispose: () => { disposed = true; },
    }));
    const entry = registry.get("timed-out")!;
    const initializing = orchestrator.initOne(entry);
    await vi.advanceTimersByTimeAsync(201);
    await initializing;

    const disposing = orchestrator.disposeOne(entry);
    await Promise.resolve();
    expect(disposed).toBe(false);

    release();
    await disposing;
    expect(disposed).toBe(true);
  });

  it("runs concurrent disposal once and in reverse registry order", async () => {
    const disposed: string[] = [];
    registry.register(makePlugin("first", ["screen"], {
      dispose: () => { disposed.push("first"); },
    }));
    registry.register(makePlugin("second", ["screen"], {
      dispose: () => { disposed.push("second"); },
    }));
    await orchestrator.initAll();

    await Promise.all([orchestrator.disposeAll(), orchestrator.disposeAll()]);

    expect(disposed).toEqual(["second", "first"]);
  });

  it("aborts an active plugin signal before disposal", async () => {
    let signal: AbortSignal | undefined;
    let abortedDuringDispose = false;
    registry.register(makePlugin("signaled", ["screen"], {
      init: (ctx) => { signal = ctx.signal; },
      dispose: () => { abortedDuringDispose = signal?.aborted === true; },
    }));
    await orchestrator.initAll();

    expect(signal?.aborted).toBe(false);
    await orchestrator.disposeAll();

    expect(abortedDuringDispose).toBe(true);
  });

  it("aborts initialization when disposal is requested immediately", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    registry.register(makePlugin("racy", ["screen"], {
      init: (ctx) => {
        signal = ctx.signal;
        return gate;
      },
    }));
    const entry = registry.get("racy")!;
    const initializing = orchestrator.initOne(entry);
    const disposing = orchestrator.disposeOne(entry);
    await Promise.resolve();

    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(101);
    await disposing;
    release();
    await initializing;

    expect(entry.state).toBe("disposed");
  });
});

describe("CapabilityResolver", () => {
  it("matches plugins by required capability set", () => {
    const reg = new InMemoryRegistry();
    reg.register(makePlugin("a", ["screen"]));
    reg.register(makePlugin("b", ["terminal", "input"]));
    reg.register(makePlugin("c", ["screen", "input"]));
    const r = new CapabilityResolver(reg);
    expect(r.resolve({ capabilities: ["input"] }).map((p) => p.manifest.id)).toEqual([
      "b",
      "c",
    ]);
    expect(
      r.resolve({ capabilities: ["screen", "input"] }).map((p) => p.manifest.id)
    ).toEqual(["c"]);
  });

  it("filters by pluginId", () => {
    const reg = new InMemoryRegistry();
    reg.register(makePlugin("a", ["screen"]));
    reg.register(makePlugin("b", ["screen"]));
    const r = new CapabilityResolver(reg);
    expect(
      r.resolve({ capabilities: ["screen"], pluginId: "b" }).map((p) => p.manifest.id)
    ).toEqual(["b"]);
  });

  it("resolveOne throws when no match", () => {
    const reg = new InMemoryRegistry();
    const r = new CapabilityResolver(reg);
    expect(() => r.resolveOne({ capabilities: ["terminal"] })).toThrow();
  });

  it("cache invalidates on explicit call", () => {
    const reg = new InMemoryRegistry();
    reg.register(makePlugin("a", ["screen"]));
    const r = new CapabilityResolver(reg);
    expect(r.resolve({ capabilities: ["screen"] })).toHaveLength(1);
    reg.register(makePlugin("b", ["screen"]));
    expect(r.resolve({ capabilities: ["screen"] })).toHaveLength(1);
    r.invalidate();
    expect(r.resolve({ capabilities: ["screen"] })).toHaveLength(2);
  });
});

describe("guard", () => {
  it("requireCapability throws when missing", () => {
    const p = makePlugin("a", ["screen"]);
    expect(() => requireCapability(p, "terminal")).toThrow();
    expect(() => requireCapability(p, "screen")).not.toThrow();
  });

  it("hasAll returns true only when all capabilities present", () => {
    const p = makePlugin("a", ["screen", "input"]);
    expect(hasAll(p, ["screen"])).toBe(true);
    expect(hasAll(p, ["screen", "input"])).toBe(true);
    expect(hasAll(p, ["screen", "terminal"])).toBe(false);
  });
});

describe("BuiltinPluginLoader", () => {
  it("loads plugins into registry in order", () => {
    const reg = new InMemoryRegistry();
    const loader = new BuiltinPluginLoader({ registry: reg });
    loader.load([makePlugin("a", ["screen"]), makePlugin("b", ["terminal"])]);
    expect(reg.list().map((e) => e.plugin.manifest.id)).toEqual(["a", "b"]);
  });
});
