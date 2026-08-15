import { describe, it, expect } from "vitest";
import { META_TOOL_DESCRIPTORS } from "./meta/index.js";

/**
 * Regression guard for #57: every tool's inputSchema must be valid JSON Schema
 * draft 2020-12 (what the Claude API validates against). The specific breakage
 * was z.tuple() serialised under draft-07 as array-form `items` (`items: [..]`),
 * which 2020-12 removed in favour of `prefixItems` — the API then 400s the whole
 * tools array. This test fails if ANY tool re-introduces a draft-07 array-`items`.
 */

function findArrayItems(node: unknown, path: string, hits: string[]): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) findArrayItems(node[i], `${path}[${i}]`, hits);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      // draft-07 tuple form: `items` whose value is an array. 2020-12 uses `prefixItems`.
      if (k === "items" && Array.isArray(v)) hits.push(`${path}.items (array-form — use prefixItems)`);
      findArrayItems(v, `${path}.${k}`, hits);
    }
  }
}

describe("tool schemas are draft 2020-12 (#57)", () => {
  it("no tool inputSchema uses draft-07 array-form `items`", () => {
    const offenders: string[] = [];
    for (const d of META_TOOL_DESCRIPTORS) {
      const hits: string[] = [];
      findArrayItems(d.meta.tool.inputSchema, d.name, hits);
      offenders.push(...hits);
    }
    expect(offenders, `draft-07 tuple schemas found:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("a tuple field (input.waypoints) emits prefixItems, not array items", () => {
    const input = META_TOOL_DESCRIPTORS.find((d) => d.name === "input");
    expect(input).toBeTruthy();
    const props = (input!.meta.tool.inputSchema as any).properties;
    const waypoints = props?.waypoints;
    expect(waypoints?.type).toBe("array");
    // 2020-12 tuple: items has prefixItems, never an array of item schemas.
    expect(Array.isArray(waypoints?.items)).toBe(false);
    expect(Array.isArray(waypoints?.items?.prefixItems)).toBe(true);
  });
});
