import type { ToolDefinition } from "../registry.js";
import { unhideTools, hideTools, getModuleStatus } from "../registry.js";
import { deviceTools } from "../device-tools.js";
import { UnknownActionError } from "../../errors.js";

const handlers = new Map<string, ToolDefinition["handler"]>();
for (const t of deviceTools) {
  handlers.set(t.tool.name.replace(/^device_/, ""), t.handler);
}

export const deviceMeta: ToolDefinition = {
  tool: {
    name: "device",
    description: "Device management + module loading. list/set/set_target/get_target: devices. enable_module/disable_module/list_modules: load browser/desktop/store tools on demand.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "set", "set_target", "get_target", "enable_module", "disable_module", "list_modules"],
        },
        deviceId: { type: "string", description: "Device ID (for set)" },
        platform: {
          type: "string",
          enum: ["android", "ios", "desktop", "aurora", "browser"],
          description: "Filter by platform or target platform",
        },
        target: {
          type: "string",
          enum: ["android", "ios", "desktop", "aurora", "browser"],
          description: "Target platform to switch to (for set_target)",
        },
        module: {
          type: "string",
          enum: ["browser", "desktop", "store"],
          description: "Module name (for enable_module/disable_module)",
        },
      },
      required: ["action"],
    },
  },
  handler: async (args, ctx, depth) => {
    const action = args.action as string;

    // Module management actions
    if (action === "list_modules") {
      const modules = getModuleStatus();
      if (modules.length === 0) return { text: "All modules are loaded." };
      const lines = modules.map(m => `  ${m.name}: ${m.status}`);
      return { text: `Modules:\n${lines.join("\n")}` };
    }
    if (action === "enable_module") {
      const mod = args.module as string;
      if (!mod) throw new Error("module parameter is required for enable_module");
      unhideTools([mod]);
      return { text: `Module "${mod}" enabled. Tools are now visible.` };
    }
    if (action === "disable_module") {
      const mod = args.module as string;
      if (!mod) throw new Error("module parameter is required for disable_module");
      hideTools([mod]);
      return { text: `Module "${mod}" disabled.` };
    }

    // Device actions
    const handler = handlers.get(action);
    if (!handler) throw new UnknownActionError("device", action, ["list", "set", "set_target", "get_target", "enable_module", "disable_module", "list_modules"]);
    return handler(args, ctx, depth);
  },
};

export const deviceAliases: Record<string, { tool: string; defaults: Record<string, unknown> }> = {
  device_list: { tool: "device", defaults: { action: "list" } },
  device_set: { tool: "device", defaults: { action: "set" } },
  device_set_target: { tool: "device", defaults: { action: "set_target" } },
  device_get_target: { tool: "device", defaults: { action: "get_target" } },
};
