import type { Platform } from "../../device-manager.js";
import { findElements } from "../../ui-tree/ui-parser.js";
import { DeviceNotFoundError, DeviceOfflineError, AdbNotInstalledError, ValidationError, MobileError } from "../../errors.js";
import { MAX_RECURSION_DEPTH } from "../context.js";
import { defineTool, z } from "../define-tool.js";
import { textResult } from "../../utils/tool-result.js";
import { sleep } from "../../utils/sleep.js";
import { FLOW } from "../../constants/timeouts.js";
import {
  ContentBlock,
  FLOW_MAX_DURATION,
  FLOW_MAX_REPEAT,
  FLOW_MAX_STEPS,
  FlowStep,
  FlowStepResult,
  TurboStepContext,
  captureTurboScreenshot,
  collectCompactUiTree,
  linkFlowAbortController,
  collectFailureDiag,
  flowStepSchema,
  formatFlowResults,
  isFlowActionAllowed,
  platformEnum,
  FlowTimeoutError,
  runWithDeadline,
  turboFastTrack,
} from "./common.js";
import type { FastTrackResult } from "./common.js";
import { deviceIdField } from "../common-schema.js";

export const flowRun = defineTool({
  name: "flow_run",
  description: "Multi-step automation flow with conditionals, loops, error handling. Use for E2E testing instead of calling tools one-by-one. Set turbo:true for UI context per step (experimental). Max 20 steps. Cancellation and time budgets are cooperative; non-cancellable operations may overrun or finish after cancellation.",
  schema: z.object({
    steps: z.array(flowStepSchema).optional().describe("Steps to execute sequentially"),
    maxDuration: z.number().finite().min(1).max(FLOW_MAX_DURATION).optional()
      .describe("Orchestration time budget in ms (default: 30000, max: 60000). Cancellation is cooperative; non-cancellable operations may overrun this budget or finish after timeout."),
    platform: platformEnum,
    deviceId: deviceIdField,
    turbo: z
      .boolean()
      .optional()
      .describe("[experimental] Rich UI feedback per step. Compact UI tree after each step, screenshot on failure."),
  }),
  handler: async (args, ctx, _depth = 0) => {
    if ((_depth ?? 0) > MAX_RECURSION_DEPTH) {
      throw new Error(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded. Nested batch_commands/run_flow calls are limited to prevent stack overflow.`);
    }
    const flowDepth = _depth ?? 0;

    const platform = args.platform as Platform | undefined;
    const flowDeviceId = args.deviceId as string | undefined;
    const steps = args.steps as FlowStep[] | undefined;
    const maxDuration = Math.min((args.maxDuration as number) ?? 30000, FLOW_MAX_DURATION);
    const currentPlatform = (platform ?? ctx.deviceManager.getCurrentPlatform()) as string;
    const turbo = args.turbo ?? ctx.turboDefault;

    if (!steps || steps.length === 0) {
      throw new ValidationError("No steps provided.");
    }
    if (steps.length > FLOW_MAX_STEPS) {
      throw new ValidationError(`Too many steps (${steps.length}). Maximum is ${FLOW_MAX_STEPS}.`);
    }

    // Validate all actions are allowed
    for (const step of steps) {
      if (!isFlowActionAllowed(step.action, step.args ?? {})) {
        throw new MobileError(
          `Action "${step.action}" is not allowed in flows. Use only safe actions.`,
          "FLOW_SECURITY"
        );
      }
    }

    const flowStart = Date.now();
    const results: FlowStepResult[] = [];
    const flowController = new AbortController();
    const unlinkParentSignal = linkFlowAbortController(ctx.signal, flowController);
    const flowSignal = flowController.signal;
    try {
    let flowTimedOut = false;
    const abortFlow = (): void => {
      flowTimedOut = true;
      if (!flowController.signal.aborted) flowController.abort();
    };
    const remainingFlowMs = (): number => Math.max(0, maxDuration - (Date.now() - flowStart));
    const waitWithinDeadline = (delayMs: number): Promise<void> =>
      runWithDeadline(() => sleep(delayMs), remainingFlowMs(), abortFlow, flowSignal);
    const runNestedTool = (
      name: string,
      toolArgs: Record<string, unknown>,
      depth: number,
    ): Promise<unknown> =>
      runWithDeadline(
        () => ctx.handleTool(name, toolArgs, depth, flowSignal),
        remainingFlowMs(),
        abortFlow,
        flowSignal,
      );

    // Turbo state
    const turboContexts = turbo ? new Map<number, TurboStepContext>() : undefined;
    const turboScreenshots: Array<{ data: string; mimeType: string }> = [];
    const TURBO_MAX_SCREENSHOTS = 5;

    /** Collect optional turbo feedback without exceeding the flow deadline. */
    async function collectTurboContext(
      stepNum: number,
      stepSuccess: boolean,
      stepPlatform: string,
      stepDeviceId: string | undefined,
      parentDepth: number,
    ): Promise<void> {
      if (!turbo || !turboContexts) return;
      if (turboContexts.has(stepNum)) return; // Already populated by fast-track
      const ctx_entry: TurboStepContext = {};

      if (!stepSuccess && turboScreenshots.length < TURBO_MAX_SCREENSHOTS) {
        // Parallel: UI tree + screenshot simultaneously on failure
        const [uiTree, screenshot] = await Promise.all([
          collectCompactUiTree(ctx, stepPlatform, stepDeviceId, flowSignal).catch(() => ""),
          captureTurboScreenshot(
            ctx,
            stepPlatform,
            stepDeviceId,
            flowSignal,
            FLOW.UI_TREE_TIMEOUT_MS,
            parentDepth,
          ),
        ]);
        if (uiTree) ctx_entry.uiTree = uiTree;
        if (screenshot) {
          turboScreenshots.push(screenshot);
          ctx_entry.hasScreenshot = true;
        }
      } else {
        // Success: only UI tree (no screenshot needed)
        try {
          const uiTree = await collectCompactUiTree(ctx, stepPlatform, stepDeviceId, flowSignal);
          if (uiTree) ctx_entry.uiTree = uiTree;
        } catch { /* silently skip */ }
      }

      turboContexts.set(stepNum, ctx_entry);
    }

    async function collectTurboContextWithinDeadline(
      stepNum: number,
      stepSuccess: boolean,
      stepPlatform: string,
      stepDeviceId: string | undefined,
      parentDepth: number,
    ): Promise<boolean> {
      try {
        await runWithDeadline(
          () => collectTurboContext(
            stepNum,
            stepSuccess,
            stepPlatform,
            stepDeviceId,
            parentDepth,
          ),
          remainingFlowMs(),
          abortFlow,
          flowSignal,
        );
        return !flowTimedOut && !ctx.signal?.aborted;
      } catch (error: unknown) {
        if (error instanceof FlowTimeoutError || ctx.signal?.aborted) return false;
        throw error;
      }
    }

    async function collectFailureDiagWithinDeadline(
      stepIndex: number,
      stepPlatform: string,
      stepDeviceId?: string,
    ): Promise<string> {
      try {
        return await runWithDeadline(
          () => collectFailureDiag(ctx, stepPlatform, stepIndex, stepDeviceId, flowSignal),
          remainingFlowMs(),
          abortFlow,
          flowSignal,
        );
      } catch (error: unknown) {
        if (error instanceof FlowTimeoutError || ctx.signal?.aborted) return "";
        throw error;
      }
    }

    /** Build the final return value, factoring in turbo multi-content. */
    function buildReturn(
      totalMs: number,
      diagBlock: string = "",
      incomplete = flowTimedOut || ctx.signal?.aborted === true,
    ) {
      const text = formatFlowResults(results, totalMs, diagBlock, turboContexts, incomplete);
      if (turbo && turboScreenshots.length > 0) {
        const content: ContentBlock[] = [{ type: "text", text }];
        for (const ss of turboScreenshots) {
          content.push({ type: "image", data: ss.data, mimeType: ss.mimeType });
        }
        // See note in flow_batch — multi-content (text+image) requires casting
        // because ToolResult is text-only in the canonical typing.
        return { content, text } as unknown as ReturnType<typeof textResult>;
      }
      return textResult(text);
    }
    function finishTimeout(step: FlowStep, durationMs: number) {
      const timeoutResult: FlowStepResult = {
        step: results.length + 1,
        action: step.action,
        label: step.label,
        success: false,
        message: "Flow timeout",
        durationMs,
      };
      results.push(timeoutResult);
      return turbo
        ? buildReturn(Date.now() - flowStart, "", true)
        : textResult(formatFlowResults(results, Date.now() - flowStart, "", undefined, true));
    }
    function finishCancelled(step: FlowStep, durationMs: number) {
      results.push({
        step: results.length + 1,
        action: step.action,
        label: step.label,
        success: false,
        message: "Flow cancelled",
        durationMs,
      });
      return buildReturn(Date.now() - flowStart, "", true);
    }

    let lastStepPlatform = currentPlatform;
    let lastStepDeviceId = flowDeviceId;

    for (let i = 0; i < steps.length; i++) {
      if (flowTimedOut || remainingFlowMs() <= 0) {
        return finishTimeout(steps[i], 0);
      }
      if (ctx.signal?.aborted) return finishCancelled(steps[i], 0);

      const step = steps[i];
      const stepArgs = { platform: currentPlatform, ...step.args } as Record<string, unknown>;
      if (flowDeviceId !== undefined && stepArgs.deviceId === undefined) {
        stepArgs.deviceId = flowDeviceId;
      }
      const stepPlatform = typeof stepArgs.platform === "string" ? stepArgs.platform : currentPlatform;
      const stepDeviceId = typeof stepArgs.deviceId === "string" ? stepArgs.deviceId : undefined;
      lastStepPlatform = stepPlatform;
      lastStepDeviceId = stepDeviceId;
      if (turbo && !("hints" in stepArgs)) {
        stepArgs.hints = false; // turbo collects UI tree itself via collectCompactUiTree, skip redundant hints
      }
      const onError = step.on_error ?? "stop";

      const repeatTimes = step.repeat?.times ? Math.min(step.repeat.times, FLOW_MAX_REPEAT) : 1;
      const untilFound = step.repeat?.until_found;
      const untilNotFound = step.repeat?.until_not_found;
      const hasRepeatCondition = untilFound || untilNotFound;
      const maxIterations = hasRepeatCondition ? FLOW_MAX_REPEAT : repeatTimes;

      let lastStepResult: FlowStepResult | null = null;

      for (let iter = 0; iter < maxIterations; iter++) {
        if (flowTimedOut || remainingFlowMs() <= 0) {
          return finishTimeout(step, 0);
        }
        if (ctx.signal?.aborted) return finishCancelled(step, 0);

        const stepStart = Date.now();

        try {
          // Turbo fast-track: execute the action and UI dump in one ADB call.
          // Only simple Android actions without repeats or recovery steps qualify.
          if (turbo && !hasRepeatCondition && repeatTimes === 1 && !step.if_not_found) {
            const fastResult = await turboFastTrack(
              step,
              ctx,
              stepPlatform,
              stepDeviceId,
              remainingFlowMs(),
              abortFlow,
              flowSignal,
            );
            if (flowTimedOut || remainingFlowMs() <= 0) {
              return finishTimeout(step, Date.now() - stepStart);
            }
            if (ctx.signal?.aborted) return finishCancelled(step, Date.now() - stepStart);
            if (fastResult) {
              lastStepResult = {
                step: i + 1, action: step.action, label: step.label,
                success: true, message: "OK",
                durationMs: Date.now() - stepStart,
              };
              if (turboContexts) {
                turboContexts.set(i + 1, { uiTree: fastResult.uiCompact });
              }
              break;
            }
          }
          await runNestedTool(step.action, stepArgs, (_depth ?? 0) + 1);
          if (flowTimedOut || remainingFlowMs() <= 0) {
            return finishTimeout(step, Date.now() - stepStart);
          }
          if (ctx.signal?.aborted) return finishCancelled(step, Date.now() - stepStart);

          lastStepResult = {
            step: i + 1,
            action: step.action,
            label: step.label,
            success: true,
            message: "OK",
            durationMs: Date.now() - stepStart,
          };

          if (hasRepeatCondition) {
            try {
              const elements = await runWithDeadline(
                () => ctx.getElementsForPlatform(stepPlatform, stepDeviceId),
                remainingFlowMs(),
                abortFlow,
                flowSignal,
              );
              if (untilFound) {
                const found = findElements(elements, { text: untilFound });
                if (found.length > 0) break;
              }
              if (untilNotFound) {
                const found = findElements(elements, { text: untilNotFound });
                if (found.length === 0) break;
              }
            } catch (condErr: unknown) {
              if (condErr instanceof FlowTimeoutError) throw condErr;
              if (condErr instanceof DeviceNotFoundError || condErr instanceof DeviceOfflineError || condErr instanceof AdbNotInstalledError) {
                throw condErr;
              }
            }
            await waitWithinDeadline(
              turbo ? FLOW.STEP_DELAY_TURBO_MS : FLOW.STEP_DELAY_NORMAL_MS,
            );
          }
        } catch (error: unknown) {
          const durationMs = Date.now() - stepStart;
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (error instanceof FlowTimeoutError || flowTimedOut || remainingFlowMs() <= 0) {
            return finishTimeout(step, durationMs);
          }
          if (ctx.signal?.aborted) return finishCancelled(step, durationMs);
          const isNotFound = errorMessage.includes("not found") || errorMessage.includes("No element");

          if (isNotFound && step.if_not_found) {
            if (step.if_not_found === "skip") {
              lastStepResult = {
                step: i + 1, action: step.action, label: step.label,
                success: true, message: `Skipped (element not found)`, durationMs,
              };
              break;
            } else if (step.if_not_found === "scroll_down" || step.if_not_found === "scroll_up") {
              try {
                await runNestedTool(
                  "swipe",
                  {
                    direction: step.if_not_found === "scroll_down" ? "up" : "down",
                    platform: stepPlatform,
                    ...(stepDeviceId !== undefined ? { deviceId: stepDeviceId } : {}),
                  },
                  (_depth ?? 0) + 1,
                );
                await waitWithinDeadline(
                  turbo ? FLOW.STEP_DELAY_TURBO_MS : FLOW.STEP_DELAY_NORMAL_MS,
                );
                await runNestedTool(step.action, stepArgs, (_depth ?? 0) + 1);
                if (flowTimedOut || remainingFlowMs() <= 0) {
                  return finishTimeout(step, Date.now() - stepStart);
                }
                if (ctx.signal?.aborted) {
                  return finishCancelled(step, Date.now() - stepStart);
                }
                lastStepResult = {
                  step: i + 1, action: step.action, label: step.label,
                  success: true, message: `OK (after ${step.if_not_found})`,
                  durationMs: Date.now() - stepStart,
                };
                break;
              } catch (retryErr: unknown) {
                if (retryErr instanceof FlowTimeoutError) {
                  return finishTimeout(step, Date.now() - stepStart);
                }
                if (ctx.signal?.aborted) return finishCancelled(step, Date.now() - stepStart);
                lastStepResult = {
                  step: i + 1, action: step.action, label: step.label,
                  success: false, message: `Action failed (after ${step.if_not_found})`,
                  durationMs: Date.now() - stepStart,
                };
                if (onError === "stop") break;
                if (onError === "skip") break;
              }
            } else {
              lastStepResult = {
                step: i + 1, action: step.action, label: step.label,
                success: false, message: "Action failed", durationMs,
              };
            }
            break;
          }

          if (onError === "retry" && iter < maxIterations - 1) {
            try {
              await waitWithinDeadline(
                turbo ? FLOW.STEP_DELAY_TURBO_MS : FLOW.STEP_DELAY_NORMAL_MS,
              );
            } catch (error: unknown) {
              if (error instanceof FlowTimeoutError) {
                return finishTimeout(step, Date.now() - stepStart);
              }
              if (ctx.signal?.aborted) {
                return finishCancelled(step, Date.now() - stepStart);
              }
              throw error;
            }
            continue;
          }

          lastStepResult = {
            step: i + 1, action: step.action, label: step.label,
            success: false, message: "Action failed", durationMs,
          };

          if (onError === "stop") {
            results.push(lastStepResult);
            const contextCollected = await collectTurboContextWithinDeadline(
              i + 1,
              false,
              stepPlatform,
              stepDeviceId,
              flowDepth,
            );
            if (!contextCollected) return buildReturn(Date.now() - flowStart, "", true);
            if (!turbo) {
              const diag = await collectFailureDiagWithinDeadline(i + 1, stepPlatform, stepDeviceId);
              return buildReturn(Date.now() - flowStart, diag);
            }
            return buildReturn(Date.now() - flowStart);
          }
          break;
        }
      }

      if (lastStepResult) {
        results.push(lastStepResult);
        const contextCollected = await collectTurboContextWithinDeadline(
          lastStepResult.step,
          lastStepResult.success,
          stepPlatform,
          stepDeviceId,
          flowDepth,
        );
        if (!contextCollected) return buildReturn(Date.now() - flowStart, "", true);

        if (!lastStepResult.success && (step.on_error ?? "stop") === "stop") {
          if (!turbo) {
            const diag = await collectFailureDiagWithinDeadline(i + 1, stepPlatform, stepDeviceId);
            return buildReturn(Date.now() - flowStart, diag);
          }
          return buildReturn(Date.now() - flowStart);
        }
      }
    }

    if (!turbo) {
      const lastFailed = results.length > 0 && !results[results.length - 1].success;
      const diag = lastFailed
        ? await collectFailureDiagWithinDeadline(results.length, lastStepPlatform, lastStepDeviceId)
        : "";
      return buildReturn(Date.now() - flowStart, diag);
    }
    return buildReturn(Date.now() - flowStart);
    } finally {
      unlinkParentSignal();
    }
  },
});
