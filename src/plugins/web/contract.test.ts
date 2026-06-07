import { describe, expect, it } from "vitest";

import { runPluginContract } from "../contract-suite.js";
import { WEB_PLUGIN_MANIFEST, createWebPlugin } from "./index.js";

runPluginContract(createWebPlugin);

describe("WebPlugin specifics", () => {
  it("declares minimal capability set (screen/input/ui only)", () => {
    expect([...WEB_PLUGIN_MANIFEST.capabilities].sort()).toEqual(
      ["input", "screen", "ui"].sort()
    );
  });

  it("does NOT declare shell, appLifecycle, or permissions", () => {
    const caps = WEB_PLUGIN_MANIFEST.capabilities;
    expect(caps).not.toContain("shell");
    expect(caps).not.toContain("appLifecycle");
    expect(caps).not.toContain("permissions");
  });
});
