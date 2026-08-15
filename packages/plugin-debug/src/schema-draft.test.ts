/**
 * Regression guard: every debug tool's inputSchema must be JSON Schema draft 2020-12.
 *
 * Background (#57): zod 4's z.tuple() with draft-07 emits array-form `items`
 * which causes a 400 on every Claude tool call. This test pins the schema format
 * to draft-2020-12 across all debug tools so no regression can slip through.
 */

import { describe, it, expect } from "vitest";
import { DebugController } from "./controller.js";
import { buildDebugTools } from "./tools.js";

// Use a no-op controller for schema inspection — no real adb/lldb needed.
const TOOL_NAMES = [
  "debug_attach",
  "debug_break",
  "debug_remove_break",
  "debug_poll",
  "debug_pause_state",
  "debug_threads",
  "debug_eval",
  "debug_set_var",
  "debug_step",
  "debug_resume",
  "debug_detach",
  "debug_sessions",
] as const;

// Build tools with a minimal stub controller (constructor has defaults).
const tools = buildDebugTools(new DebugController());

describe("debug tools — JSON Schema draft 2020-12 compliance", () => {
  it("exports exactly 12 tools (all 12 registered)", () => {
    expect(tools).toHaveLength(12);
  });

  it("each tool name matches the expected surface", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
  });

  for (const toolName of TOOL_NAMES) {
    it(`${toolName}: inputSchema has $schema = draft 2020-12`, () => {
      const tool = tools.find((t) => t.name === toolName);
      expect(tool).toBeDefined();
      const schema = tool!.inputSchema;
      expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    });

    it(`${toolName}: inputSchema does NOT use array-form items (draft-07 z.tuple regression)`, () => {
      const tool = tools.find((t) => t.name === toolName);
      const schema = tool!.inputSchema;
      // Stringify the whole schema and check that no "items" key appears as an array.
      // draft-07 z.tuple() → "items": [{...}, {...}] which Claude rejects with 400.
      const raw = JSON.stringify(schema);
      // If items appears as an array value (draft-07 tuple), stringify will show
      // "items":[{  — we assert this pattern is absent.
      expect(raw).not.toMatch(/"items"\s*:\s*\[/);
    });

    it(`${toolName}: inputSchema type is "object"`, () => {
      const tool = tools.find((t) => t.name === toolName);
      const schema = tool!.inputSchema;
      expect(schema["type"]).toBe("object");
    });
  }
});
