/**
 * Unified MCP tool result builders.
 *
 * Three legacy shapes existed across *-tools.ts:
 *   { text }
 *   { text, isError: true }
 *   { content: [{ type: "text", text }] }
 *
 * This module standardises on the MCP content-block shape. Helpers below
 * cover the 95% case; for non-text payloads build the object directly.
 */

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: TextContentBlock[];
  isError?: boolean;
}

export const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

export const errorResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

export const jsonResult = (value: unknown): ToolResult =>
  textResult(typeof value === "string" ? value : JSON.stringify(value, null, 2));
