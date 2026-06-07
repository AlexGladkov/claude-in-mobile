import { runPluginContract } from "../contract-suite.js";
import { createAndroidPlugin, ANDROID_PLUGIN_MANIFEST } from "./index.js";
import { describe, expect, it } from "vitest";

runPluginContract(createAndroidPlugin);

describe("AndroidPlugin specifics", () => {
  it("declares deviceMgmt capability (Android multi-device support)", () => {
    expect(ANDROID_PLUGIN_MANIFEST.capabilities).toContain("deviceMgmt");
  });

  it("exposes the AndroidAdapter on the plugin instance", () => {
    const p = createAndroidPlugin() as { adapter: unknown };
    expect(p.adapter).toBeDefined();
  });
});
