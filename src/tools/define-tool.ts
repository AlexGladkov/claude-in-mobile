import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import type { ToolDefinition } from "./registry.js";
import { runToolSafely } from "../utils/run-tool-safely.js";
import type { ToolResult } from "../utils/tool-result.js";
import { ValidationError } from "../errors.js";

export interface DefineToolOptions<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  handler: (
    args: z.output<S>,
    ctx: ToolContext,
    depth?: number,
  ) => Promise<ToolResult>;
  /** Error code used when handler throws non-MobileError. */
  errorCode?: string;
}

/**
 * Build a `ToolDefinition` from a zod schema + typed handler.
 *
 * Responsibilities:
 *   - Generate JSON Schema (`tool.inputSchema`) from zod — single source.
 *   - Validate `args` at runtime; invalid input THROWS `ValidationError`
 *     (a `MobileError` subclass) so existing tests that assert
 *     `.rejects.toThrow(ValidationError)` keep working and so the typed
 *     error vocabulary is consistent across hand-coded and zod-validated
 *     tools.
 *   - Wrap handler with `runToolSafely` so unknown thrown errors are
 *     normalised; `MobileError` (including `ValidationError`) propagates.
 */
export function defineTool<S extends z.ZodTypeAny>(
  opts: DefineToolOptions<S>,
): ToolDefinition {
  const json = z.toJSONSchema(opts.schema, {
    target: "draft-7",
  }) as Record<string, unknown>;

  const tool: Tool = {
    name: opts.name,
    description: opts.description,
    inputSchema: {
      type: "object",
      ...(json as { properties?: unknown; required?: unknown }),
    } as Tool["inputSchema"],
  };

  const safeHandler = runToolSafely<z.output<S>, ToolContext>(
    (args, ctx) => opts.handler(args, ctx),
    opts.errorCode ?? "TOOL_FAILED",
  );

  return {
    tool,
    handler: async (rawArgs, ctx, _depth) => {
      const parsed = opts.schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new ValidationError(issues);
      }
      return safeHandler(parsed.data, ctx);
    },
  };
}

/** Re-export `z` so callers don't need a separate import line. */
export { z };
