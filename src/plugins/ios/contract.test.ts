import { describe, expect, it } from "vitest";

import { runPluginContract } from "../contract-suite.js";
import { IOS_PLUGIN_MANIFEST, createIosPlugin } from "./index.js";

runPluginContract(createIosPlugin);

describe("IosPlugin specifics", () => {
  it("declares permissions capability (iOS runtime permissions)", () => {
    expect(IOS_PLUGIN_MANIFEST.capabilities).toContain("permissions");
  });

  it("exposes the IosAdapter on the plugin instance", () => {
    const p = createIosPlugin() as { adapter: unknown };
    expect(p.adapter).toBeDefined();
  });
});
