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
  collectFailureDiag,
  flowStepSchema,
  formatFlowResults,
  isFlowActionAllowed,
  platformEnum,
  turboFastTrack,
} from "./common.js";

export const flowRun = defineTool({
  name: "flow_run",
  description: "Multi-step automation flow with conditionals, loops, error handling. Use for E2E testing instead of calling tools one-by-one. Set turbo:true for UI context per step (experimental). Max 20 steps.",
  schema: z.object({
    steps: z.array(flowStepSchema).optional().describe("Steps to execute sequentially"),
    maxDuration: z.number().optional().describe("Max total duration in ms (default: 30000, max: 60000)"),
    platform: platformEnum,
    turbo: z
      .boolean()
      .optional()
      .describe("[experimental] Rich UI feedback per step. Compact UI tree after each step, screenshot on failure."),
  }),
  handler: async (args, ctx, _depth = 0) => {
    if ((_depth ?? 0) > MAX_RECURSION_DEPTH) {
      throw new Error(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded. Nested batch_commands/run_flow calls are limited to prevent stack overflow.`);
    }

    const platform = args.platform as Platform | undefined;
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
      if (!isFlowActionAllowed(step.action)) {
        throw new MobileError(
          `Action "${step.action}" is not allowed in flows. Use only safe actions.`,
          "FLOW_SECURITY"
        );
      }
    }

    const flowStart = Date.now();
    const results: FlowStepResult[] = [];

    // Turbo state
    const turboContexts = turbo ? new Map<number, TurboStepContext>() : undefined;
    const turboScreenshots: Array<{ data: string; mimeType: string }> = [];
    const TURBO_MAX_SCREENSHOTS = 5;

    /** Collect turbo context for a step. Time spent here does NOT count against maxDuration. */
    async function collectTurboContext(stepNum: number, stepSuccess: boolean): Promise<void> {
      if (!turbo || !turboContexts) return;
      if (turboContexts.has(stepNum)) return; // Already populated by fast-track
      const ctx_entry: TurboStepContext = {};

      if (!stepSuccess && turboScreenshots.length < TURBO_MAX_SCREENSHOTS) {
        // Parallel: UI tree + screenshot simultaneously on failure
        const [uiTree, screenshot] = await Promise.all([
          collectCompactUiTree(ctx, currentPlatform).catch(() => ""),
          captureTurboScreenshot(ctx, currentPlatform),
        ]);
        if (uiTree) ctx_entry.uiTree = uiTree;
        if (screenshot) {
          turboScreenshots.push(screenshot);
          ctx_entry.hasScreenshot = true;
        }
      } else {
        // Success: only UI tree (no screenshot needed)
        try {
          const uiTree = await collectCompactUiTree(ctx, currentPlatform);
          if (uiTree) ctx_entry.uiTree = uiTree;
        } catch { /* silently skip */ }
      }

      turboContexts.set(stepNum, ctx_entry);
    }

    /** Build the final return value, factoring in turbo multi-content. */
    function buildReturn(totalMs: number, diagBlock: string = "") {
      const text = formatFlowResults(results, totalMs, diagBlock, turboContexts);
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

    for (let i = 0; i < steps.length; i++) {
      if (Date.now() - flowStart > maxDuration) {
        results.push({
          step: i + 1,
          action: steps[i].action,
          label: steps[i].label,
          success: false,
          message: `Flow timeout (${maxDuration}ms exceeded)`,
          durationMs: 0,
        });
        break;
      }

      const step = steps[i];
      const stepArgs = { platform: currentPlatform, ...step.args } as Record<string, unknown>;
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
        if (Date.now() - flowStart > maxDuration) break;

        const stepStart = Date.now();

        // Turbo fast-track: combine action + UI dump in 1 ADB call (~150-300ms saved per step)
        // Only for simple Android actions without repeat/if_not_found
        if (turbo && !hasRepeatCondition && repeatTimes === 1 && !step.if_not_found) {
          const fastResult = await turboFastTrack(step, ctx, currentPlatform, stepArgs.deviceId as string | undefined);
          if (fastResult) {
            lastStepResult = {
              step: i + 1, action: step.action, label: step.label,
              success: true, message: fastResult.message.slice(0, 200),
              durationMs: Date.now() - stepStart,
            };
            if (turboContexts) {
              turboContexts.set(i + 1, { uiTree: fastResult.uiCompact });
            }
            break; // Exit repeat loop — fast-track always single iteration
          }
        }

        try {
          const result = await ctx.handleTool(step.action, stepArgs, (_depth ?? 0) + 1);
          const text = typeof result === "object" && result !== null && "text" in result
            ? (result as { text: string }).text
            : JSON.stringify(result);

          lastStepResult = {
            step: i + 1,
            action: step.action,
            label: step.label,
            success: true,
            message: text.slice(0, 200),
            durationMs: Date.now() - stepStart,
          };

          if (hasRepeatCondition) {
            try {
              const elements = await ctx.getElementsForPlatform(currentPlatform);
              if (untilFound) {
                const found = findElements(elements, { text: untilFound });
                if (found.length > 0) break;
              }
              if (untilNotFound) {
                const found = findElements(elements, { text: untilNotFound });
                if (found.length === 0) break;
              }
            } catch (condErr: unknown) {
              if (condErr instanceof DeviceNotFoundError || condErr instanceof DeviceOfflineError || condErr instanceof AdbNotInstalledError) {
                throw condErr;
              }
            }
            await sleep(turbo ? FLOW.STEP_DELAY_TURBO_MS : FLOW.STEP_DELAY_NORMAL_MS);
          }
        } catch (error: unknown) {
          const durationMs = Date.now() - stepStart;
          const errorMessage = error instanceof Error ? error.message : String(error);
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
                await ctx.handleTool("swipe", { direction: step.if_not_found === "scroll_down" ? "up" : "down", platform: currentPlatform }, (_depth ?? 0) + 1);
                await sleep(turbo ? FLOW.STEP_DELAY_TURBO_MS : FLOW.STEP_DELAY_NORMAL_MS);
                const retryResult = await ctx.handleTool(step.action, stepArgs, (_depth ?? 0) + 1);
                const retryText = typeof retryResult === "object" && retryResult !== null && "text" in retryResult
                  ? (retryResult as { text: string }).text
                  : JSON.stringify(retryResult);
                lastStepResult = {
                  step: i + 1, action: step.action, label: step.label,
                  success: true, message: `${retryText.slice(0, 150)} (after ${step.if_not_found})`,
                  durationMs: Date.now() - stepStart,
                };
                break;
              } catch (retryErr: unknown) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                lastStepResult = {
                  step: i + 1, action: step.action, label: step.label,
                  success: false, message: `${retryMsg} (after ${step.if_not_found})`,
                  durationMs: Date.now() - stepStart,
                };
                if (onError === "stop") break;
                if (onError === "skip") break;
              }
            } else {
              lastStepResult = {
                step: i + 1, action: step.action, label: step.label,
                success: false, message: errorMessage, durationMs,
              };
            }
            break;
          }

          if (onError === "retry" && iter < maxIterations - 1) {
            await sleep(turbo ? FLOW.STEP_DELAY_TURBO_MS : FLOW.STEP_DELAY_NORMAL_MS);
            if (Date.now() - flowStart > maxDuration) break;
            continue;
          }

          lastStepResult = {
            step: i + 1, action: step.action, label: step.label,
            success: false, message: errorMessage, durationMs,
          };

          if (onError === "stop") {
            results.push(lastStepResult);
            // Turbo context collected outside maxDuration timer
            await collectTurboContext(i + 1, false);
            if (!turbo) {
              const diag = await collectFailureDiag(ctx, currentPlatform, i + 1);
              return textResult(formatFlowResults(results, Date.now() - flowStart, diag));
            }
            return buildReturn(Date.now() - flowStart);
          }
          break;
        }
      }

      if (lastStepResult) {
        results.push(lastStepResult);
        // Turbo: collect UI context after each step (outside maxDuration timer)
        await collectTurboContext(lastStepResult.step, lastStepResult.success);

        if (!lastStepResult.success && (step.on_error ?? "stop") === "stop") {
          if (!turbo) {
            const diag = await collectFailureDiag(ctx, currentPlatform, i + 1);
            return textResult(formatFlowResults(results, Date.now() - flowStart, diag));
          }
          return buildReturn(Date.now() - flowStart);
        }
      }
    }

    if (!turbo) {
      const lastFailed = results.length > 0 && !results[results.length - 1].success;
      const diag = lastFailed ? await collectFailureDiag(ctx, currentPlatform, results.length) : "";
      return textResult(formatFlowResults(results, Date.now() - flowStart, diag));
    }
    return buildReturn(Date.now() - flowStart);
  },
});
