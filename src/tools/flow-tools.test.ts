import { describe, it, expect, vi, beforeEach } from "vitest";
import { flowTools } from "./flow-tools.js";
import { registerTools, resetRegistry } from "./registry.js";
import { MobileError, ValidationError } from "../errors.js";
import type { ToolContext } from "./context.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function findHandler(name: string) {
  const def = flowTools.find(t => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in flowTools`);
  return def.handler;
}

function makeMockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "android"),
    } as any,
    getCachedElements: vi.fn(() => []),
    setCachedElements: vi.fn(),
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: vi.fn(async () => ""),
    getElementsForPlatform: vi.fn(async () => []),
    iosTreeToUiElements: vi.fn(() => []),
    formatIOSUITree: vi.fn(() => ""),
    platformParam: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "" },
    handleTool: vi.fn(async () => ({ text: "ok" })),
    ...overrides,
  };
}

beforeEach(() => {
  resetRegistry();

  // Register some safe tools that flow actions allow
  registerTools([
    {
      tool: { name: "input_tap", description: "Tap", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "tapped" }),
    },
    {
      tool: { name: "system_wait", description: "Wait", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "waited" }),
    },
    {
      tool: { name: "system_shell", description: "Shell", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "shell executed" }),
    },
  ]);
});

// ──────────────────────────────────────────────
// flow_batch — security and validation
// ──────────────────────────────────────────────

describe("flow_batch", () => {
  const handler = findHandler("flow_batch");

  it("throws FLOW_SECURITY for blocked action system_shell", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        commands: [{ name: "system_shell", arguments: { command: "ls" } }],
      }, ctx)
    ).rejects.toThrow(MobileError);

    try {
      await handler({
        commands: [{ name: "system_shell", arguments: { command: "ls" } }],
      }, ctx);
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("FLOW_SECURITY");
      expect((e as MobileError).message).toContain("system_shell");
      expect((e as MobileError).message).toContain("not allowed");
    }
  });

  it("throws ValidationError for empty commands array", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ commands: [] }, ctx)
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for undefined commands", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ commands: undefined }, ctx)
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for more than 50 commands", async () => {
    const ctx = makeMockContext();
    const commands = Array.from({ length: 51 }, (_, i) => ({
      name: "input_tap",
      arguments: { x: i, y: i },
    }));
    await expect(
      handler({ commands }, ctx)
    ).rejects.toThrow(ValidationError);

    try {
      await handler({ commands }, ctx);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).message).toContain("51");
      expect((e as ValidationError).message).toContain("50");
    }
  });

  it("accepts exactly 50 commands with valid actions", async () => {
    const ctx = makeMockContext();
    const commands = Array.from({ length: 50 }, () => ({
      name: "input_tap",
      arguments: { x: 100, y: 200 },
    }));
    // Should not throw validation error (may fail on actual tool execution but not on validation)
    const result = await handler({ commands }, ctx);
    expect(result).toBeDefined();
  });

  it("blocks system_shell even among other valid commands", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        commands: [
          { name: "input_tap", arguments: { x: 100, y: 200 } },
          { name: "system_shell", arguments: { command: "rm -rf /" } },
          { name: "system_wait", arguments: { ms: 100 } },
        ],
      }, ctx)
    ).rejects.toThrow(MobileError);
  });
});

// ──────────────────────────────────────────────
// flow_run — security and validation
// ──────────────────────────────────────────────

describe("flow_run", () => {
  const handler = findHandler("flow_run");

  it("throws FLOW_SECURITY for blocked action system_shell", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        steps: [{ action: "system_shell" }],
      }, ctx)
    ).rejects.toThrow(MobileError);

    try {
      await handler({ steps: [{ action: "system_shell" }] }, ctx);
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("FLOW_SECURITY");
      expect((e as MobileError).message).toContain("system_shell");
    }
  });

  it("throws ValidationError for empty steps array", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ steps: [] }, ctx)
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for more than 20 steps", async () => {
    const ctx = makeMockContext();
    const steps = Array.from({ length: 21 }, () => ({
      action: "input_tap",
      args: { x: 100, y: 200 },
    }));
    await expect(
      handler({ steps }, ctx)
    ).rejects.toThrow(ValidationError);

    try {
      await handler({ steps }, ctx);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).message).toContain("21");
      expect((e as ValidationError).message).toContain("20");
    }
  });

  it("blocks system_shell among other valid steps", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        steps: [
          { action: "input_tap", args: { x: 100, y: 200 } },
          { action: "system_shell", args: { command: "ls" } },
        ],
      }, ctx)
    ).rejects.toThrow(MobileError);
  });
});

// ──────────────────────────────────────────────
// flow_parallel — security and validation
// ──────────────────────────────────────────────

describe("flow_parallel", () => {
  const handler = findHandler("flow_parallel");

  it("throws FLOW_SECURITY for blocked action system_shell", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        action: "system_shell",
        devices: ["emulator-5554"],
        args: { command: "ls" },
      }, ctx)
    ).rejects.toThrow(MobileError);

    try {
      await handler({
        action: "system_shell",
        devices: ["emulator-5554"],
        args: { command: "ls" },
      }, ctx);
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("FLOW_SECURITY");
      expect((e as MobileError).message).toContain("system_shell");
    }
  });

  it("throws ValidationError for empty devices array", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ action: "input_tap", devices: [] }, ctx)
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for more than 10 devices", async () => {
    const ctx = makeMockContext();
    const devices = Array.from({ length: 11 }, (_, i) => `device-${i}`);
    await expect(
      handler({ action: "input_tap", devices }, ctx)
    ).rejects.toThrow(ValidationError);
  });

  it("accepts valid action on multiple devices", async () => {
    const ctx = makeMockContext();
    const result = await handler({
      action: "input_tap",
      devices: ["emulator-5554", "emulator-5556"],
      args: { x: 100, y: 200 },
    }, ctx);
    expect(result).toBeDefined();
    expect((result as any).text).toContain("input_tap");
  });
});
