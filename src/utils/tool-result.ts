/**
 * Unified MCP tool result builders.
 *
 * Legacy shapes existed across *-tools.ts:
 *   { text }
 *   { text, isError: true }
 *   { content: [{ type: "text", text }] }
 *
 * Unified shape carries BOTH `content` (MCP spec) and `text` (legacy callers
 * + existing tests) so migration is non-breaking. New code should rely on
 * `content` only; `text` is deprecated and may be dropped in a future major.
 */

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: TextContentBlock[];
  /** @deprecated kept for backwards compatibility — read `content` instead. */
  text: string;
  isError?: boolean;
}

export const textResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  text,
});

export const errorResult = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
  text,
  isError: true,
});

export const jsonResult = (value: unknown): ToolResult => {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return textResult(text);
};
