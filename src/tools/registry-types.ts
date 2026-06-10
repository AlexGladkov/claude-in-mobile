import { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "./context.js";
import type { ModuleCategory } from "../profiles.js";

export interface ToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>, ctx: ToolContext, depth?: number) => Promise<unknown>;
}

export interface EnrichedModuleStatus {
  name: string;
  status: "loaded" | "available" | "disabled";
  description?: string;
  category?: ModuleCategory;
  actions?: string[];
}
