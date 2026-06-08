import { MobileError } from "../errors.js";
import { errorResult, type ToolResult } from "./tool-result.js";

export type ToolHandler<TArgs = Record<string, unknown>, TCtx = unknown> = (
  args: TArgs,
  ctx: TCtx,
) => Promise<ToolResult>;

/**
 * Wrap a tool handler so any thrown error becomes a structured error result
 * instead of propagating out of the MCP boundary.
 *
 * MobileError preserves its code; unknown errors are wrapped with the fallback
 * code so call-sites get a stable error vocabulary.
 */
export function runToolSafely<TArgs, TCtx>(
  handler: ToolHandler<TArgs, TCtx>,
  fallbackCode = "TOOL_FAILED",
): ToolHandler<TArgs, TCtx> {
  return async (args, ctx) => {
    try {
      return await handler(args, ctx);
    } catch (err) {
      if (err instanceof MobileError) {
        return errorResult(`[${err.code}] ${err.message}`);
      }
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`[${fallbackCode}] ${message}`);
    }
  };
}

export const toMobileError = (err: unknown, code = "TOOL_FAILED"): MobileError => {
  if (err instanceof MobileError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new MobileError(message, code);
};
