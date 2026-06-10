import { MobileError } from "../errors.js";
import { errorResult, type ToolResult } from "./tool-result.js";

export type ToolHandler<TArgs = Record<string, unknown>, TCtx = unknown> = (
  args: TArgs,
  ctx: TCtx,
) => Promise<ToolResult>;

/**
 * Wrap a tool handler so unknown thrown errors become a structured error result.
 *
 * MobileError is re-thrown unchanged — the MCP layer + existing tests rely on
 * typed errors propagating with their code intact. Only non-MobileError throws
 * (TypeError, ReferenceError, ad-hoc `throw new Error(...)`, etc.) are converted
 * to `errorResult` with the fallback code, ensuring the MCP boundary never sees
 * an uncaught exception.
 */
export function runToolSafely<TArgs, TCtx>(
  handler: ToolHandler<TArgs, TCtx>,
  fallbackCode = "TOOL_FAILED",
): ToolHandler<TArgs, TCtx> {
  return async (args, ctx) => {
    try {
      return await handler(args, ctx);
    } catch (err) {
      if (err instanceof MobileError) throw err;
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
