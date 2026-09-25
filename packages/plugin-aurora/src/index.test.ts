import { describe, expect, it } from "vitest";

import { AURORA_PLUGIN_MANIFEST } from "./index.js";

describe("Aurora plugin capabilities", () => {
  it("does not advertise unsupported UI hierarchy operations", () => {
    expect(AURORA_PLUGIN_MANIFEST.capabilities).not.toContain("ui");
  });
});
