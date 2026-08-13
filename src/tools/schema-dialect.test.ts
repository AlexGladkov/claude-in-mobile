/**
 * JSON Schema dialect invariant for advertised tool schemas.
 *
 * The Anthropic Messages API validates every `tools[].custom.input_schema`
 * against the JSON Schema draft 2020-12 meta-schema. One draft-07-only
 * construct anywhere in the catalogue rejects the ENTIRE request with
 * HTTP 400 (`tools.N.custom.input_schema: JSON schema is invalid`) — the MCP
 * server then contributes nothing to that client, so the blast radius is the
 * whole connection, not the one offending tool.
 *
 * v3.15.0 shipped exactly that: `input.waypoints` uses `z.tuple([...])`, and
 * `defineTool` was generating schemas with `target: "draft-7"`, where zod
 * emits the tuple form `items: [schemaA, schemaB]`. Draft 2020-12 defines
 * `items` as `{"$dynamicRef": "#meta"}` — a schema, never an array — and moved
 * positional schemas to `prefixItems`.
 *
 * Hidden meta tools are checked too: they become visible via
 * `device(enable_module:…)`, so a bad schema there surfaces later and looks
 * unrelated to the module that introduced it.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "./define-tool.js";
import { META_TOOL_DESCRIPTORS } from "./meta/index.js";

/**
 * Collect JSON pointers to constructs that are valid in draft-07 but rejected
 * by the draft 2020-12 meta-schema.
 */
function findDraft7OnlyForms(
  node: unknown,
  path: string,
  out: string[] = [],
): string[] {
  if (Array.isArray(node)) {
    node.forEach((item, i) => findDraft7OnlyForms(item, `${path}[${i}]`, out));
    return out;
  }
  if (node === null || typeof node !== "object") return out;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const child = `${path}.${key}`;

    if (key === "items" && Array.isArray(value)) {
      out.push(`${child} — tuple form of "items"; 2020-12 wants "prefixItems"`);
    }
    if (key === "additionalItems") {
      out.push(`${child} — "additionalItems" was removed in 2020-12`);
    }

    // Property names are arbitrary user keys, so a property literally called
    // "items" or "additionalItems" must not be mistaken for a keyword.
    if (key === "properties" && value !== null && typeof value === "object") {
      for (const [prop, subSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        findDraft7OnlyForms(subSchema, `${child}.${prop}`, out);
      }
      continue;
    }

    findDraft7OnlyForms(value, child, out);
  }

  return out;
}

describe("advertised tool schemas are draft 2020-12 clean", () => {
  it.each(META_TOOL_DESCRIPTORS.map((d) => [d.name, d] as const))(
    "%s",
    (_name, descriptor) => {
      const violations = findDraft7OnlyForms(
        descriptor.meta.tool.inputSchema,
        descriptor.name,
      );
      expect(violations).toEqual([]);
    },
  );
});

describe("defineTool emits the 2020-12 dialect", () => {
  // Guards the invariant directly, so the suite above cannot go green merely
  // because no tool happens to use a tuple at the moment.
  const probe = defineTool({
    name: "schema_dialect_probe",
    description: "Probe tool used to assert the emitted JSON Schema dialect.",
    schema: z.object({
      waypoints: z.array(z.tuple([z.number(), z.number()])).optional(),
    }),
    handler: async () => ({ text: "ok" }),
  });

  const waypoints = (
    probe.tool.inputSchema as {
      properties: Record<string, { items?: unknown }>;
    }
  ).properties.waypoints;

  it("encodes tuples as prefixItems, not as an array of schemas", () => {
    const inner = waypoints.items as {
      items?: unknown;
      prefixItems?: unknown[];
    };
    expect(Array.isArray(inner.items)).toBe(false);
    expect(inner.prefixItems).toHaveLength(2);
  });

  it("leaves no draft-07-only construct in the generated schema", () => {
    expect(
      findDraft7OnlyForms(probe.tool.inputSchema, "schema_dialect_probe"),
    ).toEqual([]);
  });
});
