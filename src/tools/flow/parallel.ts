import { MAX_RECURSION_DEPTH } from "../context.js";
import { ValidationError, MobileError } from "../../errors.js";
import { defineTool, z } from "../define-tool.js";
import { textResult } from "../../utils/tool-result.js";
import {
  FLOW_MAX_DURATION,
  FlowTimeoutError,
  PARALLEL_MAX_DEVICES,
  isFlowActionAllowed,
  linkFlowAbortController,
  runWithDeadline,
} from "./common.js";

export const flowParallel = defineTool({
  name: "flow_parallel",
  description: "Run same action on multiple devices in parallel. Uses Promise.allSettled for concurrent execution. Cancellation and time budgets are cooperative; non-cancellable operations may overrun or finish after cancellation.",
  schema: z.object({
    action: z.string().describe("Tool name to execute on each device"),
    args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the action (deviceId will be injected per device)"),
    devices: z
      .array(z.string())
      .optional()
      .describe("Array of device IDs to target. Use device(action:'list') to get available devices."),
    maxDuration: z.number().finite().min(1).max(FLOW_MAX_DURATION).optional()
      .describe("Orchestration time budget in ms (default: 30000, max: 60000). Cancellation is cooperative; non-cancellable operations may overrun this budget or finish after timeout."),
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
    if (!isFlowActionAllowed(action, actionArgs)) {
      throw new MobileError(
        `Action "${action}" is not allowed in parallel flows. Use only safe actions.`,
        "FLOW_SECURITY"
      );
    }

    const maxDuration = Math.min(args.maxDuration ?? 30_000, FLOW_MAX_DURATION);
    const parallelStart = Date.now();
    const parallelController = new AbortController();
    const unlinkParentSignal = linkFlowAbortController(ctx.signal, parallelController);
    const parallelSignal = parallelController.signal;
    try {
    let timedOut = false;
    const remainingMs = (): number => Math.max(0, maxDuration - (Date.now() - parallelStart));
    const abortParallel = (): void => {
      timedOut = true;
      if (!parallelController.signal.aborted) parallelController.abort();
    };

    // Run on each device by injecting deviceId into args. Keep the device ID
    // in both result variants so one failed peer is still attributable.
    const results = await Promise.all(
      devices.map(async (deviceId) => {
        try {
          await runWithDeadline(
            () => ctx.handleTool(
              action,
              { ...actionArgs, deviceId },
              (_depth ?? 0) + 1,
              parallelSignal,
            ),
            remainingMs(),
            abortParallel,
            parallelSignal,
          );
          if (timedOut || remainingMs() <= 0) {
            abortParallel();
            throw new FlowTimeoutError();
          }
          if (ctx.signal?.aborted) throw new Error("Flow cancelled");
          return { deviceId, status: "fulfilled" as const };
        } catch (reason: unknown) {
          const deadlineExpired =
            reason instanceof FlowTimeoutError || timedOut || remainingMs() <= 0;
          if (deadlineExpired) abortParallel();
          return {
            deviceId,
            status: "rejected" as const,
            timedOut: deadlineExpired,
            cancelled: ctx.signal?.aborted === true && !deadlineExpired,
          };
        }
      }),
    );

    const lines: string[] = [
      `Parallel${timedOut ? " incomplete (max duration exceeded)" : ctx.signal?.aborted ? " cancelled" : ""}: ${action} on ${devices.length} devices`,
    ];

    for (const result of results) {
      if (result.status === "fulfilled") {
        lines.push(`  ${result.deviceId}: OK — OK`);
      } else {
        const status = result.timedOut
          ? "Max duration exceeded"
          : result.cancelled
            ? "Cancelled"
            : "Action failed";
        lines.push(`  ${result.deviceId}: FAIL — ${status}`);
      }
    }

    const failed = results.filter(r => r.status === "rejected").length;
    lines.push(`\n${devices.length - failed}/${devices.length} OK`);

    return textResult(lines.join("\n"));
    } finally {
      unlinkParentSignal();
    }

  },
});
