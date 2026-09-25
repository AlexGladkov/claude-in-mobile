import { MAX_RECURSION_DEPTH } from "../context.js";
import { MobileError } from "../../errors.js";
import { truncateOutput } from "../../utils/truncate.js";
import { defineTool, z } from "../define-tool.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import { sleep } from "../../utils/sleep.js";
import {
  SYNC_ASSERT_DEFAULT_DELAY,
  SYNC_ASSERT_MAX_RETRIES,
  SYNC_ASSERT_RETRY_DELAY,
  SYNC_MAX_DURATION,
  SyncTimeoutError,
  SyncCancellationError,
  getDeviceIdForRole,
  getGroup,
  isSyncActionAllowed,
  runWithSyncDeadline,
  validateStepArgs,
} from "./common.js";

export const syncAssertCross = defineTool({
  name: "sync_assert_cross",
  description: "Cross-device assertion: perform action on source device, verify result on target device with retries.",
  schema: z.object({
    group: z.string().describe("Sync group name"),
    source_role: z.string().describe("Role that performs the source action"),
    source_action: z.string().describe("Action to execute on source device"),
    source_args: z.record(z.string(), z.unknown()).optional().describe("Source action arguments"),
    target_role: z.string().describe("Role that verifies the result"),
    target_action: z.string().describe("Assertion action on target device"),
    maxDuration: z.number().finite().min(1).max(SYNC_MAX_DURATION).optional()
      .describe("Assertion orchestration time budget in ms (default: 60000, max: 120000). Cancellation is cooperative; non-cancellable operations may overrun this budget or finish after timeout."),
    target_args: z.record(z.string(), z.unknown()).optional().describe("Target action arguments"),
    delay_ms: z.number().optional().describe("Delay between source and target (default: 1000)"),
    retries: z.number().optional().describe("Max target assertion retries (default: 3)"),
    label: z.string().optional().describe("Assertion label"),
  }),
  handler: async (args, ctx, depth = 0) => {
    if ((depth ?? 0) > MAX_RECURSION_DEPTH) {
      throw new MobileError(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded.`, "MAX_RECURSION");
    }

    const groupName = args.group;
    const sourceRole = args.source_role;
    const sourceAction = args.source_action;
    const sourceArgs = (args.source_args ?? {}) as Record<string, unknown>;
    const targetRole = args.target_role;
    const targetAction = args.target_action;
    const targetArgs = (args.target_args ?? {}) as Record<string, unknown>;
    const maxDuration = Math.min(args.maxDuration ?? 60_000, SYNC_MAX_DURATION);
    const delayMs = Math.min(args.delay_ms ?? SYNC_ASSERT_DEFAULT_DELAY, 30_000);
    const retries = Math.max(1, Math.min(Math.floor(args.retries ?? 3), SYNC_ASSERT_MAX_RETRIES));
    const label = args.label || `${sourceAction} → ${targetAction}`;

    const group = getGroup(groupName);
    const sourceDeviceId = getDeviceIdForRole(group, sourceRole);
    const targetDeviceId = getDeviceIdForRole(group, targetRole);

    // Validate actions
    for (const [action, actionArgs] of [
      [sourceAction, sourceArgs],
      [targetAction, targetArgs],
    ] as const) {
      if (!isSyncActionAllowed(action, actionArgs)) {
        throw new MobileError(`Action "${action}" is not allowed in sync.`, "SYNC_SECURITY");
      }
    }

    if (sourceArgs) validateStepArgs(sourceArgs);
    if (targetArgs) validateStepArgs(targetArgs);
    const totalStart = Date.now();
    const runController = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const abortRun = (timedOutRun = true): void => {
      timedOut ||= timedOutRun;
      if (!runController.signal.aborted) runController.abort();
    };
    const abortFromParent = (): void => {
      cancelled = true;
      abortRun(false);
    };
    const parentSignal = ctx.signal;
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    if (parentSignal?.aborted) abortFromParent();
    const remainingMs = (): number => Math.max(0, maxDuration - (Date.now() - totalStart));
    const isTimeout = (error: unknown): boolean =>
      error instanceof SyncTimeoutError || timedOut || remainingMs() <= 0;
    const isCancelled = (error: unknown): boolean =>
      cancelled || error instanceof SyncCancellationError;
    const timeoutMessage = `Cross-assert FAILED (${label}) — Max duration exceeded (${maxDuration}ms)`;
    const cancellationMessage = `Cross-assert CANCELLED (${label})`;
    const deadlineTimer = setTimeout(() => abortRun(), Math.max(0, maxDuration));

    try {
      // Execute source action.
      const sourceStart = Date.now();
      let sourceText: string;
      try {
        const result = await runWithSyncDeadline(
          () => ctx.handleTool(
            sourceAction,
            { ...sourceArgs, deviceId: sourceDeviceId },
            (depth ?? 0) + 1,
            runController.signal,
          ),
          remainingMs(),
          abortRun,
          runController.signal,
        );
        if (cancelled || timedOut || remainingMs() <= 0) {
          if (!cancelled) abortRun();
          return errorResult(cancelled ? cancellationMessage : timeoutMessage);
        }
        sourceText = typeof result === "object" && result !== null && "text" in result && typeof result.text === "string"
          ? result.text
          : JSON.stringify(result) ?? String(result);
      } catch (error: unknown) {
        if (isTimeout(error)) return errorResult(timeoutMessage);
        if (isCancelled(error)) return errorResult(cancellationMessage);
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult(
          `Cross-assert FAILED (${label})\n  source [${sourceRole}]: ${sourceAction} FAIL — ${msg} (${Date.now() - sourceStart}ms)`,
        );
      }
      const sourceMs = Date.now() - sourceStart;

      // Delay between source and target is part of the same absolute deadline.
      if (delayMs > 0) {
        try {
          await runWithSyncDeadline(
            () => sleep(delayMs),
            remainingMs(),
            abortRun,
            runController.signal,
          );
        } catch (error: unknown) {
          if (isTimeout(error)) return errorResult(timeoutMessage);
          if (isCancelled(error)) return errorResult(cancellationMessage);
          throw error;
        }
      }
      if (cancelled || timedOut || remainingMs() <= 0) {
        if (!cancelled) abortRun();
        return errorResult(cancelled ? cancellationMessage : timeoutMessage);
      }

      // Target assertion with retries.
      let lastError = "";
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const result = await runWithSyncDeadline(
            () => ctx.handleTool(
              targetAction,
              { ...targetArgs, deviceId: targetDeviceId },
              (depth ?? 0) + 1,
              runController.signal,
            ),
            remainingMs(),
            abortRun,
            runController.signal,
          );
          if (cancelled || timedOut || remainingMs() <= 0) {
            if (!cancelled) abortRun();
            return errorResult(cancelled ? cancellationMessage : timeoutMessage);
          }
          const targetText = typeof result === "object" && result !== null && "text" in result && typeof result.text === "string"
            ? result.text
            : JSON.stringify(result) ?? String(result);

          const totalMs = Date.now() - totalStart;
          return textResult(
            [
              `Cross-assert PASSED (${label}) — ${totalMs}ms`,
              `  source [${sourceRole}]: ${sourceAction} OK — ${truncateOutput(sourceText, { maxChars: 150, maxLines: 2 })} (${sourceMs}ms)`,
              `  delay: ${delayMs}ms`,
              `  target [${targetRole}]: ${targetAction} OK — ${truncateOutput(targetText, { maxChars: 150, maxLines: 2 })} (attempt ${attempt}/${retries})`,
            ].join("\n"),
          );
        } catch (error: unknown) {
          if (isTimeout(error)) return errorResult(timeoutMessage);
          if (isCancelled(error)) return errorResult(cancellationMessage);
          lastError = error instanceof Error ? error.message : String(error);
          if (attempt < retries) {
            try {
              await runWithSyncDeadline(
                () => sleep(SYNC_ASSERT_RETRY_DELAY),
                remainingMs(),
                abortRun,
                runController.signal,
              );
            } catch (delayError: unknown) {
              if (isTimeout(delayError)) return errorResult(timeoutMessage);
              if (isCancelled(delayError)) return errorResult(cancellationMessage);
              throw delayError;
            }
          }
        }
      }

      if (cancelled || timedOut || remainingMs() <= 0) {
        if (!cancelled) abortRun();
        return errorResult(cancelled ? cancellationMessage : timeoutMessage);
      }
      const totalMs = Date.now() - totalStart;
      return errorResult(
        [
          `Cross-assert FAILED (${label}) — ${totalMs}ms`,
          `  source [${sourceRole}]: ${sourceAction} OK — ${truncateOutput(sourceText, { maxChars: 150, maxLines: 2 })} (${sourceMs}ms)`,
          `  delay: ${delayMs}ms`,
          `  target [${targetRole}]: ${targetAction} FAIL after ${retries} retries — ${lastError}`,
        ].join("\n"),
      );
    } finally {
      clearTimeout(deadlineTimer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  },
});
