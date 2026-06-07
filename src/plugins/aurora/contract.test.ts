import { describe, expect, it } from "vitest";

import { runPluginContract } from "../contract-suite.js";
import { AURORA_PLUGIN_MANIFEST, createAuroraPlugin } from "./index.js";

runPluginContract(createAuroraPlugin);

describe("AuroraPlugin specifics", () => {
  it("does NOT declare permissions capability (Aurora has no runtime permissions)", () => {
    expect(AURORA_PLUGIN_MANIFEST.capabilities).not.toContain("permissions");
  });

  it("declares shell capability (Aurora supports remote shell via audb)", () => {
    expect(AURORA_PLUGIN_MANIFEST.capabilities).toContain("shell");
  });
});
