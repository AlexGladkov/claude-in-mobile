import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "./context.js";
import { deviceMeta } from "./meta/device-meta.js";
import { inputMeta } from "./meta/input-meta.js";
import { deviceTools } from "./device-tools.js";

function findHandler(name: string) {
  const definition = deviceTools.find((tool) => tool.tool.name === name);
  if (!definition) throw new Error(`Tool "${name}" not found in deviceTools`);
  return definition.handler;
}

function makeContext() {
  const device = {
    id: "tizen-1",
    name: "Tizen TV",
    platform: "tizen",
    state: "connected",
    isSimulator: false,
  };
  const setTarget = vi.fn();
  const ctx = {
    deviceManager: {
      getDevices: vi.fn((platform?: string) => (platform === "tizen" ? [device] : [])),
      getActiveDevice: vi.fn(() => device),
      getTarget: vi.fn(() => ({ target: "tizen", status: "connected" })),
      setTarget,
    },
  } as unknown as ToolContext;
  return { ctx, device, setTarget };
}

describe("dynamic external platform device tools", () => {
  it("lists and groups a registered non-built-in platform", async () => {
    const { ctx } = makeContext();
    const result = await findHandler("device_list")({ platform: "tizen" }, ctx);

    expect(result.text).toContain("tizen:");
    expect(result.text).toContain("tizen-1 - Tizen TV");
    expect(result.text).toContain("[ACTIVE]");
  });

  it("accepts a bounded external platform ID for target selection", async () => {
    const { ctx, setTarget } = makeContext();
    await findHandler("device_set_target")({ target: "tizen" }, ctx);

    expect(setTarget).toHaveBeenCalledWith("tizen");
  });

  it("rejects malformed platform IDs before routing", async () => {
    const { ctx } = makeContext();
    await expect(findHandler("device_set_target")({ target: "Tizen" }, ctx)).rejects.toThrow();
    await expect(
      findHandler("device_set_target")({ target: "t".repeat(129) }, ctx),
    ).rejects.toThrow();
  });

  it("routes external platform IDs through the device meta alias", async () => {
    const { ctx, setTarget } = makeContext();
    await deviceMeta.handler({ action: "set_target", target: "tizen" }, ctx);

    expect(setTarget).toHaveBeenCalledWith("tizen");
    const properties = deviceMeta.tool.inputSchema.properties as Record<string, unknown>;
    expect(properties.target).toMatchObject({
      anyOf: expect.arrayContaining([
        expect.objectContaining({ maxLength: 128 }),
      ]),
    });
  });

  it("advertises external platform IDs through the input meta schema", () => {
    const properties = inputMeta.tool.inputSchema.properties as Record<string, unknown>;
    expect(properties.platform).toMatchObject({
      anyOf: expect.arrayContaining([
        expect.objectContaining({
          maxLength: 128,
          pattern: "^[a-z0-9][a-z0-9._-]{0,127}$",
        }),
      ]),
    });
  });
});
