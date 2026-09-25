import type { ToolContext } from "../context.js";
import { getRegisteredToolNames } from "../registry.js";
import type { Scenario, ScenarioEntry, ScenarioStep } from "../../utils/scenario-store.js";
import { MobileError, ValidationError } from "../../errors.js";
import { sleep } from "../../utils/sleep.js";
import { RECORDER } from "../../constants/timeouts.js";
import { isPlaybackBlockedAction, redactScenarioLabel, redactScenarioStep } from "./redaction.js";

// ── Formatting helpers ──

export function formatEntry(e: ScenarioEntry): string {
  const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
  const date = e.updatedAt.split("T")[0];
  return `${e.name} (${e.platform}) — ${e.stepCount} steps, ${date}${tags}`;
}

export function formatStepCompact(step: ScenarioStep, i: number): string {
  const safeStep = redactScenarioStep(step);
  const label = safeStep.label ? ` (${safeStep.label})` : "";
  const sensitive = safeStep.sensitive ? " *" : "";
  const argsStr = Object.keys(safeStep.args).length > 0
    ? ` {${Object.entries(safeStep.args).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(", ")}}`
    : "";
  return `  ${i + 1}. [${safeStep.type}] ${safeStep.action}${argsStr}${label}${sensitive}`;
}

// ── Playback engine ──

const PLAYBACK_MAX_STEP_TIMEOUT = RECORDER.PLAYBACK_MAX_STEP_TIMEOUT_MS;
const PLAYBACK_MAX_DURATION = 120_000;
export const PLAYBACK_MAX_SPEED = 10;

class PlaybackTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaybackTimeoutError";
  }
}

class PlaybackCancelledError extends Error {
  constructor() {
    super("Playback cancelled");
    this.name = "PlaybackCancelledError";
  }
}

/**
 * Race a playback operation against its remaining absolute deadline or the
 * playback cancellation signal.
 *
 * A timed-out or cancelled nested action is deliberately detached so playback
 * can return promptly. Its rejection is observed to prevent an unhandled
 * rejection after the runner has already reported the terminal result.
 */
async function runWithPlaybackDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  timeoutMessage: string,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    throw new PlaybackCancelledError();
  }
  if (timeoutMs <= 0) {
    onTimeout();
    throw new PlaybackTimeoutError(timeoutMessage);
  }

  const operationPromise = Promise.resolve().then(() => {
    if (signal?.aborted) throw new PlaybackCancelledError();
    return operation();
  });
  let rejectTimeout!: (error: PlaybackTimeoutError) => void;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timeoutHandle: NodeJS.Timeout = setTimeout(() => {
    rejectTimeout(new PlaybackTimeoutError(timeoutMessage));
    onTimeout();
  }, timeoutMs);

  let abortHandler: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        abortHandler = () => reject(new PlaybackCancelledError());
        signal.addEventListener("abort", abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      })
    : undefined;

  try {
    return await (abortPromise
      ? Promise.race([operationPromise, timeoutPromise, abortPromise])
      : Promise.race([operationPromise, timeoutPromise]));
  } catch (error: unknown) {
    if (error instanceof PlaybackTimeoutError || error instanceof PlaybackCancelledError) {
      void operationPromise.catch(() => undefined);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

export interface PlaybackResult {
  step: number;
  action: string;
  label?: string;
  status: "OK" | "FAIL" | "SKIP";
  message: string;
  durationMs: number;
}

export async function executePlayback(
  scenario: Scenario,
  ctx: ToolContext,
  options: {
    speed?: number;
    stopOnFail?: boolean;
    stepTimeout?: number;
    maxDuration?: number;
    fromStep?: number;
    toStep?: number;
    dryRun?: boolean;
  },
  depth: number,
): Promise<{ results: PlaybackResult[]; totalMs: number }> {
  if (
    options.speed !== undefined
    && (!Number.isFinite(options.speed) || options.speed < 0 || options.speed > PLAYBACK_MAX_SPEED)
  ) {
    throw new ValidationError(`Playback speed must be between 0 and ${PLAYBACK_MAX_SPEED}.`);
  }
  const speed = options.speed ?? 1;
  const stopOnFail = options.stopOnFail !== false;
  const stepTimeout = Math.min(options.stepTimeout ?? 5000, PLAYBACK_MAX_STEP_TIMEOUT);
  const maxDuration = Math.min(options.maxDuration ?? 60000, PLAYBACK_MAX_DURATION);
  const fromStep = Math.max((options.fromStep ?? 1) - 1, 0);
  const toStep = Math.min(options.toStep ?? scenario.steps.length, scenario.steps.length);
  const dryRun = options.dryRun === true;

  const playbackController = new AbortController();
  let timedOut = false;
  let cancelled = false;
  const abortPlayback = (reason: "timeout" | "parent" = "timeout"): void => {
    if (reason === "parent") {
      cancelled = true;
    } else {
      timedOut = true;
    }
    if (!playbackController.signal.aborted) playbackController.abort();
  };
  const parentSignal = ctx.signal;
  const onParentAbort = (): void => abortPlayback("parent");
  if (parentSignal) {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    if (parentSignal.aborted) onParentAbort();
  }

  let deadlineTimer!: NodeJS.Timeout;
  try {
    // Pre-validate all actions
    for (const step of scenario.steps) {
      if (isPlaybackBlockedAction(step.action, step.args)) {
        throw new MobileError(
          `Action "${step.action}" is blocked in scenario playback for security`,
          "SCENARIO_ACTION_BLOCKED"
        );
      }
      if (!getRegisteredToolNames().has(step.action)) {
        throw new MobileError(
          `Unknown action "${step.action}" in scenario`,
          "SCENARIO_UNKNOWN_ACTION"
        );
      }
    }

    const outputSteps = scenario.steps.map(redactScenarioStep);

    const results: PlaybackResult[] = [];
    const playbackStart = Date.now();
    const deadline = playbackStart + Math.max(0, maxDuration);
    const remainingMs = (): number => Math.max(0, deadline - Date.now());
    deadlineTimer = setTimeout(() => abortPlayback(), remainingMs());
    const recordTimeout = (
      step: ScenarioStep,
      stepNumber: number,
      durationMs: number,
      message = "Max duration exceeded",
    ): void => {
      const safeStep = outputSteps[stepNumber - 1] ?? redactScenarioStep(step);
      results.push({
        step: stepNumber,
        action: step.action,
        label: safeStep.label,
        status: "FAIL",
        message,
        durationMs,
      });
    };
    const recordCancelled = (
      step: ScenarioStep,
      stepNumber: number,
      durationMs: number,
    ): void => {
      recordTimeout(step, stepNumber, durationMs, "Playback cancelled");
    };
    const isTimeout = (error: unknown): boolean =>
      error instanceof PlaybackTimeoutError || timedOut || remainingMs() <= 0;
    const isCancelled = (error: unknown): boolean =>
      !timedOut && (error instanceof PlaybackCancelledError || cancelled);

    for (let i = fromStep; i < toStep; i++) {
      const step = scenario.steps[i];

      // Total duration guard
      if (cancelled) {
        recordCancelled(step, i + 1, 0);
        break;
      }
      if (timedOut || remainingMs() <= 0) {
        abortPlayback();
        recordTimeout(step, i + 1, 0);
        break;
      }

      if (dryRun) {
        results.push({
          step: i + 1, action: step.action, label: outputSteps[i]?.label,
          status: "SKIP", message: "dry-run", durationMs: 0,
        });
        continue;
      }

      const stepStart = Date.now();

      // Inter-step delay is part of the same absolute playback deadline.
      if (step.delayBeforeMs > 0 && speed > 0) {
        try {
          await runWithPlaybackDeadline(
            () => sleep(Math.round(step.delayBeforeMs / speed)),
            remainingMs(),
            abortPlayback,
            "Max duration exceeded",
            playbackController.signal,
          );
        } catch (error: unknown) {
          if (isCancelled(error)) {
            recordCancelled(step, i + 1, Date.now() - stepStart);
            break;
          }
          if (isTimeout(error)) {
            recordTimeout(step, i + 1, Date.now() - stepStart);
            break;
          }
          throw error;
        }
      }
      if (cancelled) {
        recordCancelled(step, i + 1, Date.now() - stepStart);
        break;
      }
      if (timedOut || remainingMs() <= 0) {
        abortPlayback();
        recordTimeout(step, i + 1, Date.now() - stepStart);
        break;
      }

      try {
        const remaining = remainingMs();
        const actionTimeout = Math.min(stepTimeout, remaining);
        const timeoutMessage = remaining <= stepTimeout ? "Max duration exceeded" : "Step timeout";
        await runWithPlaybackDeadline(
          () => ctx.handleTool(
            step.action,
            { ...step.args, platform: scenario.platform },
            depth + 1,
            playbackController.signal,
          ),
          actionTimeout,
          abortPlayback,
          timeoutMessage,
          playbackController.signal,
        );

        if (cancelled) {
          recordCancelled(step, i + 1, Date.now() - stepStart);
          break;
        }
        if (timedOut || remainingMs() <= 0) {
          abortPlayback();
          recordTimeout(step, i + 1, Date.now() - stepStart);
          break;
        }

        results.push({
          step: i + 1, action: step.action, label: outputSteps[i]?.label,
          status: "OK", message: "OK", durationMs: Date.now() - stepStart,
        });
      } catch (error: unknown) {
        if (isCancelled(error)) {
          recordCancelled(step, i + 1, Date.now() - stepStart);
          break;
        }
        if (isTimeout(error)) {
          recordTimeout(
            step,
            i + 1,
            Date.now() - stepStart,
            remainingMs() <= 0 ? "Max duration exceeded" : "Step timeout",
          );
          break;
        }

        const onError = step.onError ?? (stopOnFail ? "stop" : "skip");

        results.push({
          step: i + 1, action: step.action, label: outputSteps[i]?.label,
          status: "FAIL", message: "Action failed",
          durationMs: Date.now() - stepStart,
        });

        if (cancelled) {
          results[results.length - 1].message = "Playback cancelled";
          break;
        }
        if (timedOut || remainingMs() <= 0) {
          abortPlayback();
          results[results.length - 1].message = "Max duration exceeded";
          break;
        }
        if (onError === "stop") break;
        // "skip" — continue to next step
        // "retry" — retry once
        if (onError === "retry") {
          if (cancelled) {
            results[results.length - 1].message = "Playback cancelled";
            break;
          }
          try {
            const remaining = remainingMs();
            const retryTimeout = Math.min(stepTimeout, remaining);
            const timeoutMessage = remaining <= stepTimeout ? "Max duration exceeded" : "Step timeout";
            await runWithPlaybackDeadline(
              () => ctx.handleTool(
                step.action,
                { ...step.args, platform: scenario.platform },
                depth + 1,
                playbackController.signal,
              ),
              retryTimeout,
              abortPlayback,
              timeoutMessage,
              playbackController.signal,
            );
            if (cancelled) {
              results[results.length - 1].message = "Playback cancelled";
              break;
            }
            if (timedOut || remainingMs() <= 0) {
              abortPlayback();
              results[results.length - 1].message = "Max duration exceeded";
              break;
            }
            // Overwrite last result with success
            results[results.length - 1] = {
              step: i + 1, action: step.action, label: outputSteps[i]?.label,
              status: "OK", message: "OK (retry)", durationMs: Date.now() - stepStart,
            };
          } catch (retryError: unknown) {
            if (isCancelled(retryError)) {
              results[results.length - 1].message = "Playback cancelled";
              break;
            }
            if (isTimeout(retryError)) {
              results[results.length - 1].message =
                remainingMs() <= 0 ? "Max duration exceeded" : "Step timeout";
              break;
            }
            // Retry also failed — keep the FAIL result
            if (stopOnFail) break;
          }
        }
      }
    }

    return { results, totalMs: Date.now() - playbackStart };
  } finally {
    clearTimeout(deadlineTimer);
    if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
  }
}

export function formatPlaybackResults(scenario: Scenario, results: PlaybackResult[], totalMs: number): string {
  const passed = results.filter(r => r.status === "OK").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const total = scenario.steps.length;

  const statusLine = failed > 0
    ? `Playback FAILED: ${scenario.name} (${scenario.platform}) — ${passed}/${total} OK, ${failed} FAILED (${totalMs}ms)`
    : `Playback OK: ${scenario.name} (${scenario.platform}) — ${passed}/${total} OK (${totalMs}ms)`;
  const safeSteps = scenario.steps.map(redactScenarioStep);

  const lines = results.map(r => {
    const scenarioStep = safeSteps[r.step - 1];
    const label = redactScenarioLabel(
      r.label ?? scenarioStep?.label,
      scenarioStep?.sensitive === true,
    );
    const labelText = label ? ` (${label})` : "";
    let message = r.status === "OK" ? "OK" : r.status === "SKIP" ? "SKIP" : "Action failed";
    if (r.status === "OK" && r.message === "OK (retry)") {
      message = "OK (retry)";
    } else if (r.status === "SKIP" && r.message === "dry-run") {
      message = "dry-run";
    } else if (r.status === "FAIL" && r.message === "Step timeout") {
      message = "Step timeout";
    } else if (r.status === "FAIL" && r.message === "Max duration exceeded") {
      message = "Max duration exceeded";
    } else if (r.status === "FAIL" && r.message === "Playback cancelled") {
      message = "Playback cancelled";
    }
    return `  ${r.step}. ${r.action}${labelText}: ${r.status} — ${message} (${r.durationMs}ms)`;
  });

  return `${statusLine}\n\n${lines.join("\n")}`;
}
