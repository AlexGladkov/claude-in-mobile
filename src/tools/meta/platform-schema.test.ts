import { describe, expect, it } from "vitest";

import { deviceMeta } from "./device-meta.js";
import { inputMeta } from "./input-meta.js";
import { screenMeta } from "./screen-meta.js";
import { uiMeta } from "./ui-meta.js";
import { systemMeta } from "./system-meta.js";
import { recorderMeta } from "./recorder-meta.js";
import { visualMeta } from "./visual-meta.js";

const CANONICAL_META_TOOLS = [
  deviceMeta,
  inputMeta,
  screenMeta,
  uiMeta,
  systemMeta,
  recorderMeta,
  visualMeta,
] as const;

function platformSchema(tool: (typeof CANONICAL_META_TOOLS)[number]): {
  anyOf?: readonly Record<string, unknown>[];
} {
  const properties = tool.tool.inputSchema.properties as Record<string, unknown>;
  return properties.platform as {
    anyOf?: readonly Record<string, unknown>[];
  };
}

describe("canonical platform schemas", () => {
  it("accepts bounded custom platform identifiers on every generic meta tool", () => {
    for (const tool of CANONICAL_META_TOOLS) {
      const schema = platformSchema(tool);
      const branches = schema.anyOf ?? [];
      const customBranch = branches.find(
        (branch) => branch.pattern === "^[a-z0-9][a-z0-9._-]{0,127}$",
      );

      expect(customBranch, `${tool.tool.name} custom platform branch`).toBeDefined();
      expect(customBranch?.minLength).toBe(1);
      expect(customBranch?.maxLength).toBe(128);
      expect(new RegExp(String(customBranch?.pattern)).test("tizen")).toBe(true);
    }
  });
});
