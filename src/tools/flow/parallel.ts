import { MAX_RECURSION_DEPTH } from "../context.js";
import { ValidationError, MobileError } from "../../errors.js";
import { truncateOutput } from "../../utils/truncate.js";
import { defineTool, z } from "../define-tool.js";
import { textResult } from "../../utils/tool-result.js";
import { PARALLEL_MAX_DEVICES, isFlowActionAllowed } from "./common.js";

export const flowParallel = defineTool({
  name: "flow_parallel",
  description: "Run same action on multiple devices in parallel. Uses Promise.allSettled for concurrent execution.",
  schema: z.object({
    action: z.string().describe("Tool name to execute on each device"),
    args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the action (deviceId will be injected per device)"),
    devices: z
      .array(z.string())
      .optional()
      .describe("Array of device IDs to target. Use device(action:'list') to get available devices."),
  }),
  handler: async (args, ctx, _depth = 0) => {
    if ((_depth ?? 0) > MAX_RECURSION_DEPTH) {
      throw new Error(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded. Nested flow calls are limited to prevent stack overflow.`);
    }

    const action = args.action;
    const actionArgs = (args.args ?? {}) as Record<string, unknown>;
    const devices = args.devices as string[] | undefined;

    if (!devices || devices.length === 0) {
      throw new ValidationError("No devices specified.");
    }

    if (devices.length > PARALLEL_MAX_DEVICES) {
      throw new ValidationError(`Too many devices (${devices.length}). Maximum is ${PARALLEL_MAX_DEVICES}.`);
    }

    if (!isFlowActionAllowed(action)) {
      throw new MobileError(
        `Action "${action}" is not allowed in parallel flows. Use only safe actions.`,
        "FLOW_SECURITY"
      );
    }

    // Run on each device by injecting deviceId into args.
    // This avoids mutating the shared global device state which would
    // cause race conditions with concurrent Promise.allSettled execution.
    const results = await Promise.allSettled(
      devices.map(async (deviceId) => {
        const result = await ctx.handleTool(action, { ...actionArgs, deviceId }, (_depth ?? 0) + 1);
        return { deviceId, result };
      })
    );

    const lines: string[] = [`Parallel: ${action} on ${devices.length} devices`];

    for (const r of results) {
      if (r.status === "fulfilled") {
        const { deviceId, result } = r.value;
        const text = typeof result === "object" && result !== null && "text" in result
          ? (result as { text: string }).text
          : JSON.stringify(result);
        lines.push(`  ${deviceId}: OK — ${truncateOutput(text, { maxChars: 200, maxLines: 5 })}`);
      } else {
        lines.push(`  ???: FAIL — ${r.reason?.message ?? String(r.reason)}`);
      }
    }

    const failed = results.filter(r => r.status === "rejected").length;
    lines.push(`\n${devices.length - failed}/${devices.length} OK`);

    return textResult(lines.join("\n"));
  },
});
