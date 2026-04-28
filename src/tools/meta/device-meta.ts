import type { ToolDefinition } from "../registry.js";
import { unhideTools, hideTools, getModuleStatus, unhideByCategory, hideByCategory } from "../registry.js";
import { deviceTools } from "../device-tools.js";
import { UnknownActionError } from "../../errors.js";
import { ALL_HIDEABLE_MODULES, ALWAYS_VISIBLE, type ModuleCategory } from "../../profiles.js";

const handlers = new Map<string, ToolDefinition["handler"]>();
for (const t of deviceTools) {
  handlers.set(t.tool.name.replace(/^device_/, ""), t.handler);
}

const VALID_CATEGORIES: ModuleCategory[] = ["core", "platform", "testing", "automation"];

/** Resolve module names from args — supports string, string[], or category */
function resolveModuleNames(args: Record<string, unknown>): string[] {
  const category = args.category as string | undefined;
  const mod = args.module as string | string[] | undefined;

  if (category) {
    if (!VALID_CATEGORIES.includes(category as ModuleCategory)) {
      throw new Error(`Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`);
    }
    // Return hideable modules in that category (resolved via metadata at runtime)
    return []; // handled separately via category ops
  }

  if (!mod) throw new Error("module or category parameter is required");

  if (Array.isArray(mod)) {
    for (const m of mod) {
      if (!ALL_HIDEABLE_MODULES.includes(m)) {
        throw new Error(`Invalid module "${m}". Valid: ${ALL_HIDEABLE_MODULES.join(", ")}`);
      }
    }
    return mod;
  }

  if (!ALL_HIDEABLE_MODULES.includes(mod)) {
    throw new Error(`Invalid module "${mod}". Valid: ${ALL_HIDEABLE_MODULES.join(", ")}`);
  }
  return [mod];
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
          oneOf: [
            { type: "string", enum: [...ALL_HIDEABLE_MODULES] },
            { type: "array", items: { type: "string", enum: [...ALL_HIDEABLE_MODULES] } },
          ],
          description: "Module name or array of names (for enable_module/disable_module)",
        },
        category: {
          type: "string",
          enum: ["core", "platform", "testing", "automation"],
          description: "Enable/disable all modules in category (for enable_module/disable_module)",
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

      // Group by category
      const byCategory = new Map<string, typeof modules>();
      const uncategorized: typeof modules = [];
      for (const m of modules) {
        if (m.category) {
          const list = byCategory.get(m.category) ?? [];
          list.push(m);
          byCategory.set(m.category, list);
        } else {
          uncategorized.push(m);
        }
      }

      const sections: string[] = [];
      for (const cat of VALID_CATEGORIES) {
        const mods = byCategory.get(cat);
        if (!mods || mods.length === 0) continue;
        const lines = mods.map(m => {
          const status = m.status === "loaded" ? "loaded" : m.status === "disabled" ? "disabled" : "available";
          const desc = m.description ? ` — ${m.description}` : "";
          return `  ${m.name} [${status}]${desc}`;
        });
        sections.push(`${cat}:\n${lines.join("\n")}`);
      }

      if (uncategorized.length > 0) {
        const lines = uncategorized.map(m => `  ${m.name}: ${m.status}`);
        sections.push(`other:\n${lines.join("\n")}`);
      }

      return { text: sections.join("\n\n") };
    }

    if (action === "enable_module") {
      const category = args.category as string | undefined;
      if (category) {
        if (!VALID_CATEGORIES.includes(category as ModuleCategory)) {
          throw new Error(`Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`);
        }
        const enabled = unhideByCategory(category as ModuleCategory);
        if (enabled.length === 0) return { text: `No hidden modules in category "${category}".` };
        return { text: `Enabled ${enabled.length} module(s) in "${category}": ${enabled.join(", ")}` };
      }

      const names = resolveModuleNames(args);
      unhideTools(names);
      return { text: `Module(s) enabled: ${names.join(", ")}. Tools are now visible.` };
    }

    if (action === "disable_module") {
      const category = args.category as string | undefined;
      if (category) {
        if (!VALID_CATEGORIES.includes(category as ModuleCategory)) {
          throw new Error(`Invalid category "${category}". Valid: ${VALID_CATEGORIES.join(", ")}`);
        }
        const disabled = hideByCategory(category as ModuleCategory, ALWAYS_VISIBLE);
        if (disabled.length === 0) return { text: `No visible modules in category "${category}" to disable.` };
        return { text: `Disabled ${disabled.length} module(s) in "${category}": ${disabled.join(", ")}` };
      }

      const names = resolveModuleNames(args);
      hideTools(names);
      return { text: `Module(s) disabled: ${names.join(", ")}` };
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
