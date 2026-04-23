import type { ToolDefinition } from "../registry.js";
import { UnknownActionError } from "../../errors.js";

interface MetaToolConfig {
  /** Meta tool name (e.g. "app", "screen") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Underlying tool definitions whose handlers are dispatched by action */
  tools: ToolDefinition[];
  /** Prefix stripped from tool names to derive action names (e.g. "app_") */
  prefix: string;
  /** Additional inputSchema properties merged into the meta tool schema */
  extraSchema?: Record<string, object>;
  /**
   * Custom action name overrides: original tool name -> action name.
   * Used when stripping the prefix alone is not enough
   * (e.g. "clipboard_get_android" -> "clipboard_get").
   */
  actionOverrides?: Record<string, string>;
}

export interface MetaToolResult {
  meta: ToolDefinition;
  aliases: Record<string, { tool: string; defaults: Record<string, unknown> }>;
}

/**
 * Creates a meta tool that dispatches to underlying tools based on an `action` parameter.
 *
 * Eliminates boilerplate: each meta file previously repeated the same pattern of
 * building a handler map, defining an inputSchema with an action enum, and writing
 * a switch/dispatch handler. This factory encapsulates all of that.
 */
export function createMetaTool(config: MetaToolConfig): MetaToolResult {
  const { name, description, tools, prefix, extraSchema, actionOverrides } = config;

  // Build handler map: action name -> handler
  const handlers = new Map<string, ToolDefinition["handler"]>();
  const actions: string[] = [];

  for (const t of tools) {
    const toolName = t.tool.name;
    const action = actionOverrides?.[toolName] ?? toolName.replace(new RegExp(`^${prefix}`), "");
    handlers.set(action, t.handler);
    actions.push(action);
  }

  // Merge all tool inputSchema properties into a single schema.
  // Start with the action enum, then merge each tool's properties (excluding
  // tool-specific "required" — the meta tool only requires "action").
  const mergedProperties: Record<string, object> = {
    action: {
      type: "string",
      enum: actions,
    },
    ...(extraSchema as Record<string, object> | undefined),
  };

  for (const t of tools) {
    const schema = t.tool.inputSchema as { properties?: Record<string, object> };
    if (schema.properties) {
      for (const [key, value] of Object.entries(schema.properties)) {
        if (key === "action") continue; // skip — we define our own action enum
        if (!(key in mergedProperties)) {
          mergedProperties[key] = value;
        }
      }
    }
  }

  const meta: ToolDefinition = {
    tool: {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: mergedProperties,
        required: ["action"],
      },
    },
    handler: async (args, ctx, depth) => {
      const action = args.action as string;
      const handler = handlers.get(action);
      if (!handler) throw new UnknownActionError(name, action, actions);
      return handler(args, ctx, depth);
    },
  };

  // Build backward-compat aliases: each underlying tool name -> meta tool with action default
  const aliases: Record<string, { tool: string; defaults: Record<string, unknown> }> = {};
  for (const t of tools) {
    const toolName = t.tool.name;
    const action = actionOverrides?.[toolName] ?? toolName.replace(new RegExp(`^${prefix}`), "");
    aliases[toolName] = { tool: name, defaults: { action } };
  }

  return { meta, aliases };
}
