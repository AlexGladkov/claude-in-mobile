import { describe, expect, it } from "vitest";

import { runPluginContract } from "../contract-suite.js";
import { DESKTOP_PLUGIN_MANIFEST, createDesktopPlugin } from "./index.js";

runPluginContract(createDesktopPlugin);

describe("DesktopPlugin specifics", () => {
  it("does NOT declare permissions capability (desktop has no runtime permissions)", () => {
    expect(DESKTOP_PLUGIN_MANIFEST.capabilities).not.toContain("permissions");
  });

  it("exposes the DesktopAdapter on the plugin instance", () => {
    const p = createDesktopPlugin() as { adapter: unknown };
    expect(p.adapter).toBeDefined();
  });
});
