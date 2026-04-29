import { describe, it, expect, beforeEach } from "vitest";
import { registerTools, registerToolsHidden, registerAliases, registerAliasesWithDefaults, resolveToolCall, getTools, unhideTools, hideTools, getModuleStatus, setToolListChangedNotifier, resetRegistry, registerAllModuleMetadata, getModuleMetadata, unhideByCategory, hideByCategory } from "./registry.js";
import type { EnrichedModuleStatus } from "./registry.js";
import { MODULE_METADATA, ALWAYS_VISIBLE } from "../profiles.js";

// Minimal mock tools for testing resolution
const mockSwipeHandler = async () => ({ text: "swiped" });
const mockTapHandler = async () => ({ text: "tapped" });

beforeEach(() => {
  // Reset all registry state for test isolation
  resetRegistry();

  // Register fresh tools for each test
  registerTools([
    {
      tool: { name: "swipe", description: "Swipe gesture", inputSchema: { type: "object", properties: {} } },
      handler: mockSwipeHandler,
    },
    {
      tool: { name: "tap", description: "Tap gesture", inputSchema: { type: "object", properties: {} } },
      handler: mockTapHandler,
    },
  ]);
});

describe("resolveToolCall", () => {
  it("should resolve direct tool calls", () => {
    const result = resolveToolCall("tap", { x: 100, y: 200 });
    expect(result).toBeDefined();
    expect(result!.handler).toBe(mockTapHandler);
    expect(result!.args).toEqual({ x: 100, y: 200 });
  });

  it("should resolve simple aliases without modifying args", () => {
    registerAliases({ click: "tap" });
    const result = resolveToolCall("click", { x: 50 });
    expect(result).toBeDefined();
    expect(result!.handler).toBe(mockTapHandler);
    expect(result!.args).toEqual({ x: 50 });
  });

  it("should resolve aliases with defaults and merge default args", () => {
    registerAliasesWithDefaults({
      swipe_up: { tool: "swipe", defaults: { direction: "up" } },
    });
    const result = resolveToolCall("swipe_up", {});
    expect(result).toBeDefined();
    expect(result!.handler).toBe(mockSwipeHandler);
    expect(result!.args).toEqual({ direction: "up" });
  });

  it("should let caller args override defaults", () => {
    registerAliasesWithDefaults({
      swipe_up: { tool: "swipe", defaults: { direction: "up" } },
    });
    const result = resolveToolCall("swipe_up", { direction: "down" });
    expect(result!.args).toEqual({ direction: "down" });
  });

  it("should merge defaults with extra caller args", () => {
    registerAliasesWithDefaults({
      swipe_up: { tool: "swipe", defaults: { direction: "up" } },
    });
    const result = resolveToolCall("swipe_up", { duration: 500 });
    expect(result!.args).toEqual({ direction: "up", duration: 500 });
  });

  it("should return undefined for unknown tools", () => {
    const result = resolveToolCall("nonexistent", {});
    expect(result).toBeUndefined();
  });

  it("should resolve chain: simple alias -> aliasWithDefaults -> tool", () => {
    // Meta tool
    const metaHandler = async () => ({ text: "meta" });
    registerTools([{
      tool: { name: "input", description: "Meta input", inputSchema: { type: "object", properties: {} } },
      handler: metaHandler,
    }]);
    // v3.1 alias with defaults
    registerAliasesWithDefaults({
      input_tap: { tool: "input", defaults: { action: "tap" } },
    });
    // v3.0 simple alias
    registerAliases({ touch: "input_tap" });

    const result = resolveToolCall("touch", { x: 100 });
    expect(result).toBeDefined();
    expect(result!.handler).toBe(metaHandler);
    expect(result!.args).toEqual({ action: "tap", x: 100 });
  });
});

describe("dynamic tool registration", () => {
  const mockBrowserHandler = async () => ({ text: "browser" });

  it("should hide tools from getTools() when registered hidden", () => {
    registerToolsHidden([{
      tool: { name: "browser", description: "Browser", inputSchema: { type: "object", properties: {} } },
      handler: mockBrowserHandler,
    }]);

    const tools = getTools();
    const browserTool = tools.find(t => t.name === "browser");
    expect(browserTool).toBeUndefined();
  });

  it("should resolve hidden tools via resolveToolCall and auto-enable them", () => {
    registerToolsHidden([{
      tool: { name: "browser", description: "Browser", inputSchema: { type: "object", properties: {} } },
      handler: mockBrowserHandler,
    }]);

    const result = resolveToolCall("browser", { action: "open" });
    expect(result).toBeDefined();
    expect(result!.handler).toBe(mockBrowserHandler);
    expect(result!.autoEnabled).toBe("browser");
    // After auto-enable, tool should be visible
    expect(getTools().find(t => t.name === "browser")).toBeDefined();
  });

  it("should show tools after unhideTools()", () => {
    registerToolsHidden([{
      tool: { name: "desktop", description: "Desktop", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "desktop" }),
    }]);

    expect(getTools().find(t => t.name === "desktop")).toBeUndefined();
    unhideTools(["desktop"]);
    expect(getTools().find(t => t.name === "desktop")).toBeDefined();
  });

  it("should hide visible tools via hideTools()", () => {
    registerTools([{
      tool: { name: "store", description: "Store", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "store" }),
    }]);

    expect(getTools().find(t => t.name === "store")).toBeDefined();
    hideTools(["store"]);
    expect(getTools().find(t => t.name === "store")).toBeUndefined();
  });

  it("should call notifier when tools are unhidden", () => {
    let notified = false;
    setToolListChangedNotifier(() => { notified = true; });

    registerToolsHidden([{
      tool: { name: "mod_a", description: "A", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "a" }),
    }]);

    unhideTools(["mod_a"]);
    expect(notified).toBe(true);
  });

  it("should report hidden tools in getModuleStatus()", () => {
    registerToolsHidden([{
      tool: { name: "mod_b", description: "B", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "b" }),
    }]);

    const status = getModuleStatus();
    const modB = status.find(m => m.name === "mod_b");
    expect(modB).toBeDefined();
    expect(modB!.status).toBe("available");
  });
});

describe("auto-enable modules", () => {
  const mockHandler = async () => ({ text: "ok" });

  it("should auto-enable hidden tool on direct resolveToolCall", () => {
    registerToolsHidden([{
      tool: { name: "browser", description: "Browser", inputSchema: { type: "object", properties: {} } },
      handler: mockHandler,
    }]);

    // Tool is hidden
    expect(getTools().find(t => t.name === "browser")).toBeUndefined();

    const result = resolveToolCall("browser", {});
    expect(result).toBeDefined();
    expect(result!.autoEnabled).toBe("browser");

    // Now visible
    expect(getTools().find(t => t.name === "browser")).toBeDefined();
  });

  it("should auto-enable hidden tool resolved via alias with defaults", () => {
    registerToolsHidden([{
      tool: { name: "desktop", description: "Desktop", inputSchema: { type: "object", properties: {} } },
      handler: mockHandler,
    }]);
    registerAliasesWithDefaults({
      launch_desktop_app: { tool: "desktop", defaults: { action: "launch" } },
    });

    expect(getTools().find(t => t.name === "desktop")).toBeUndefined();

    const result = resolveToolCall("launch_desktop_app", { app: "calc" });
    expect(result).toBeDefined();
    expect(result!.autoEnabled).toBe("desktop");
    expect(result!.args).toEqual({ action: "launch", app: "calc" });

    expect(getTools().find(t => t.name === "desktop")).toBeDefined();
  });

  it("should auto-enable hidden tool resolved via alias chain", () => {
    registerToolsHidden([{
      tool: { name: "store", description: "Store", inputSchema: { type: "object", properties: {} } },
      handler: mockHandler,
    }]);
    registerAliasesWithDefaults({
      store_list: { tool: "store", defaults: { action: "list" } },
    });
    registerAliases({ list_stores: "store_list" });

    expect(getTools().find(t => t.name === "store")).toBeUndefined();

    const result = resolveToolCall("list_stores", {});
    expect(result).toBeDefined();
    expect(result!.autoEnabled).toBe("store");
    expect(result!.args).toEqual({ action: "list" });

    expect(getTools().find(t => t.name === "store")).toBeDefined();
  });

  it("should NOT auto-enable manually disabled tool", () => {
    registerToolsHidden([{
      tool: { name: "browser", description: "Browser", inputSchema: { type: "object", properties: {} } },
      handler: mockHandler,
    }]);

    // First auto-enable it
    unhideTools(["browser"]);
    expect(getTools().find(t => t.name === "browser")).toBeDefined();

    // Manually disable via hideTools (simulating device(action:'disable_module'))
    hideTools(["browser"]);
    expect(getTools().find(t => t.name === "browser")).toBeUndefined();

    // resolveToolCall should NOT auto-enable
    const result = resolveToolCall("browser", {});
    expect(result).toBeDefined();
    expect(result!.autoEnabled).toBeNull();

    // Still hidden
    expect(getTools().find(t => t.name === "browser")).toBeUndefined();
  });

  it("should return autoEnabled: null for already visible tools", () => {
    // "tap" is registered as visible in beforeEach
    const result = resolveToolCall("tap", { x: 100 });
    expect(result).toBeDefined();
    expect(result!.autoEnabled).toBeNull();
  });

  it("should return autoEnabled: null on second call (idempotent)", () => {
    registerToolsHidden([{
      tool: { name: "browser", description: "Browser", inputSchema: { type: "object", properties: {} } },
      handler: mockHandler,
    }]);

    const first = resolveToolCall("browser", {});
    expect(first!.autoEnabled).toBe("browser");

    const second = resolveToolCall("browser", {});
    expect(second!.autoEnabled).toBeNull();
  });

  it("should clear manuallyDisabled when explicitly re-enabled via unhideTools", () => {
    registerToolsHidden([{
      tool: { name: "browser", description: "Browser", inputSchema: { type: "object", properties: {} } },
      handler: mockHandler,
    }]);

    // Manually disable
    unhideTools(["browser"]);
    hideTools(["browser"]);

    // Now explicitly re-enable (simulating device(action:'enable_module'))
    unhideTools(["browser"]);

    // Hide again (but not manually this time — via registerToolsHidden)
    registerToolsHidden([{
      tool: { name: "browser", description: "Browser", inputSchema: { type: "object", properties: {} } },
      handler: mockHandler,
    }]);

    // Should auto-enable because manuallyDisabled was cleared by unhideTools
    const result = resolveToolCall("browser", {});
    expect(result!.autoEnabled).toBe("browser");
  });

  it("should notify tool list changed on auto-enable", () => {
    let notified = false;
    setToolListChangedNotifier(() => { notified = true; });

    registerToolsHidden([{
      tool: { name: "browser", description: "Browser", inputSchema: { type: "object", properties: {} } },
      handler: mockHandler,
    }]);

    resolveToolCall("browser", {});
    expect(notified).toBe(true);
  });
});

describe("module metadata", () => {
  const mockHandler = async () => ({ text: "ok" });

  beforeEach(() => {
    registerAllModuleMetadata(MODULE_METADATA);
  });

  it("should register and retrieve module metadata", () => {
    const meta = getModuleMetadata("input");
    expect(meta).toBeDefined();
    expect(meta!.name).toBe("input");
    expect(meta!.category).toBe("core");
    expect(meta!.actions.length).toBeGreaterThan(0);
  });

  it("should return undefined for unknown module metadata", () => {
    expect(getModuleMetadata("nonexistent")).toBeUndefined();
  });

  it("should return enriched status with description and category", () => {
    registerToolsHidden([{
      tool: { name: "browser", description: "Browser", inputSchema: { type: "object", properties: {} } },
      handler: mockHandler,
    }]);

    const statuses = getModuleStatus();
    const browser = statuses.find(s => s.name === "browser");
    expect(browser).toBeDefined();
    expect(browser!.description).toBeTruthy();
    expect(browser!.category).toBe("platform");
    expect(browser!.actions).toBeDefined();
    expect(browser!.status).toBe("available");
  });

  it("should show disabled status for manually disabled modules", () => {
    registerTools([{
      tool: { name: "browser", description: "Browser", inputSchema: { type: "object", properties: {} } },
      handler: mockHandler,
    }]);
    hideTools(["browser"]);

    const statuses = getModuleStatus();
    const browser = statuses.find(s => s.name === "browser");
    expect(browser).toBeDefined();
    expect(browser!.status).toBe("disabled");
  });

  it("should show loaded status for visible modules", () => {
    registerTools([{
      tool: { name: "input", description: "Input", inputSchema: { type: "object", properties: {} } },
      handler: mockHandler,
    }]);

    const statuses = getModuleStatus();
    const input = statuses.find(s => s.name === "input");
    expect(input).toBeDefined();
    expect(input!.status).toBe("loaded");
  });
});

describe("category operations", () => {
  const mockHandler = async () => ({ text: "ok" });

  beforeEach(() => {
    registerAllModuleMetadata(MODULE_METADATA);
  });

  it("unhideByCategory should unhide all hidden modules in category", () => {
    registerToolsHidden([
      { tool: { name: "browser", description: "Browser", inputSchema: { type: "object", properties: {} } }, handler: mockHandler },
      { tool: { name: "desktop", description: "Desktop", inputSchema: { type: "object", properties: {} } }, handler: mockHandler },
      { tool: { name: "store", description: "Store", inputSchema: { type: "object", properties: {} } }, handler: mockHandler },
    ]);

    // All three are "platform" category
    const enabled = unhideByCategory("platform");
    expect(enabled).toContain("browser");
    expect(enabled).toContain("desktop");
    expect(enabled).toContain("store");

    // Verify they're visible
    expect(getTools().find(t => t.name === "browser")).toBeDefined();
    expect(getTools().find(t => t.name === "desktop")).toBeDefined();
    expect(getTools().find(t => t.name === "store")).toBeDefined();
  });

  it("unhideByCategory should return empty if no hidden modules in category", () => {
    registerTools([
      { tool: { name: "browser", description: "Browser", inputSchema: { type: "object", properties: {} } }, handler: mockHandler },
    ]);

    const enabled = unhideByCategory("platform");
    // browser is already visible, so nothing to unhide
    // desktop/store not registered, so not in hiddenTools
    expect(enabled).not.toContain("browser");
  });

  it("hideByCategory should hide visible modules, skip always-visible", () => {
    registerTools([
      { tool: { name: "device", description: "Device", inputSchema: { type: "object", properties: {} } }, handler: mockHandler },
      { tool: { name: "screen", description: "Screen", inputSchema: { type: "object", properties: {} } }, handler: mockHandler },
      { tool: { name: "input", description: "Input", inputSchema: { type: "object", properties: {} } }, handler: mockHandler },
    ]);

    // "core" category includes device, screen, input — but device+screen are ALWAYS_VISIBLE
    const disabled = hideByCategory("core", ALWAYS_VISIBLE);
    expect(disabled).toContain("input");
    expect(disabled).not.toContain("device");
    expect(disabled).not.toContain("screen");

    // input hidden, device/screen still visible
    expect(getTools().find(t => t.name === "input")).toBeUndefined();
    expect(getTools().find(t => t.name === "device")).toBeDefined();
    expect(getTools().find(t => t.name === "screen")).toBeDefined();
  });
});
