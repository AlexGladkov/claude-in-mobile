import { describe, it, expect, beforeEach } from "vitest";
import { registerTools, registerAliases, registerAliasesWithDefaults, resolveToolCall, getTools } from "./registry.js";

// Minimal mock tools for testing resolution
const mockSwipeHandler = async () => ({ text: "swiped" });
const mockTapHandler = async () => ({ text: "tapped" });

beforeEach(() => {
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
});
