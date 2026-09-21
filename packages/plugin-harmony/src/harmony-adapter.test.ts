import type { PluginContext, ToolDefinition } from "@mcp-devices/plugin-api";
import { describe, expect, it, vi } from "vitest";

import { HdcClient } from "./client.js";
import type { HdcExecutor } from "./client.js";
import { HarmonyAdapter } from "./harmony-adapter.js";
import { buildDeviceShellCommand } from "mcp-devices/utils/device-shell";
import {
  HARMONY_PLUGIN_MANIFEST,
  HarmonyPlugin,
} from "./index.js";

function context(registerTool: (definition: ToolDefinition) => void): PluginContext {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: {},
    eventBus: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    registerTool,
  };
}

describe("HarmonyAdapter", () => {
  it("forwards per-call device IDs without changing selection", async () => {
    const calls: string[][] = [];
    const executor: HdcExecutor = (_binary, args) => {
      calls.push([...args]);
      return "";
    };
    const client = new HdcClient({ executor, deviceId: "selected" });
    const adapter = new HarmonyAdapter(client);

    await adapter.swipe(1, 2, 3, 4, 500, "explicit");

    expect(adapter.getSelectedDeviceId()).toBe("selected");
    expect(calls[0]).toEqual([
      "-t",
      "explicit",
      "shell",
      buildDeviceShellCommand([
        "uitest", "uiInput", "swipe", "1", "2", "3", "4", "200",
      ]),
    ]);
  });

  it("registers its module-aware Harmony-specific ability tool", async () => {
    const calls: string[][] = [];
    const executor: HdcExecutor = (_binary, args) => {
      calls.push([...args]);
      return "started";
    };
    const plugin = new HarmonyPlugin(new HarmonyAdapter(new HdcClient({ executor })));
    const tools = new Map<string, ToolDefinition>();
    plugin.init(context((definition) => tools.set(definition.name, definition)));

    expect([...tools.keys()]).toEqual(HARMONY_PLUGIN_MANIFEST.tools);
    await expect(tools.get("harmony_launch_ability")?.handler({
      bundleId: "com.example.demo",
      ability: "MainAbility",
      moduleName: "entry",
      deviceId: "phone",
    })).resolves.toEqual({ message: "started" });
    expect(calls[0]).toEqual([
      "-t",
      "phone",
      "shell",
      buildDeviceShellCommand([
        "aa", "start", "-b", "com.example.demo", "-a", "MainAbility", "-m", "entry",
      ]),
    ]);
  });
});
