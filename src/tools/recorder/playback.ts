import type { ToolContext } from "../context.js";
import { getRegisteredToolNames } from "../registry.js";
import type { Scenario, ScenarioEntry, ScenarioStep } from "../../utils/scenario-store.js";
import { truncateOutput } from "../../utils/truncate.js";
import { MobileError } from "../../errors.js";
import { sleep } from "../../utils/sleep.js";
import { RECORDER } from "../../constants/timeouts.js";
import { PLAYBACK_BLOCKED_ACTIONS } from "./redaction.js";

// ── Formatting helpers ──

export function formatEntry(e: ScenarioEntry): string {
  const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
  const date = e.updatedAt.split("T")[0];
  return `${e.name} (${e.platform}) — ${e.stepCount} steps, ${date}${tags}`;
}

export function formatStepCompact(step: ScenarioStep, i: number): string {
  const label = step.label ? ` (${step.label})` : "";
  const sensitive = step.sensitive ? " *" : "";
  const argsStr = Object.keys(step.args).length > 0
    ? ` {${Object.entries(step.args).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(", ")}}`
    : "";
  return `  ${i + 1}. [${step.type}] ${step.action}${argsStr}${label}${sensitive}`;
}

// ── Playback engine ──

const PLAYBACK_MAX_STEP_TIMEOUT = RECORDER.PLAYBACK_MAX_STEP_TIMEOUT_MS;
const PLAYBACK_MAX_DURATION = 120_000;
const PLAYBACK_MAX_SPEED = 10;

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
  const speed = Math.min(Math.max(options.speed ?? 1, 0), PLAYBACK_MAX_SPEED);
  const stopOnFail = options.stopOnFail !== false;
  const stepTimeout = Math.min(options.stepTimeout ?? 5000, PLAYBACK_MAX_STEP_TIMEOUT);
  const maxDuration = Math.min(options.maxDuration ?? 60000, PLAYBACK_MAX_DURATION);
  const fromStep = Math.max((options.fromStep ?? 1) - 1, 0);
  const toStep = Math.min(options.toStep ?? scenario.steps.length, scenario.steps.length);
  const dryRun = options.dryRun === true;

  // Pre-validate all actions
  for (const step of scenario.steps) {
    if (PLAYBACK_BLOCKED_ACTIONS.has(step.action)) {
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

  const results: PlaybackResult[] = [];
  const playbackStart = Date.now();

  for (let i = fromStep; i < toStep; i++) {
    const step = scenario.steps[i];

    // Total duration guard
    if (Date.now() - playbackStart > maxDuration) {
      results.push({
        step: i + 1, action: step.action, label: step.label,
        status: "FAIL", message: "Max duration exceeded", durationMs: 0,
      });
      break;
    }

    if (dryRun) {
      results.push({
        step: i + 1, action: step.action, label: step.label,
        status: "SKIP", message: "dry-run", durationMs: 0,
      });
      continue;
    }

    // Inter-step delay
    if (step.delayBeforeMs > 0 && speed > 0) {
      await sleep(Math.round(step.delayBeforeMs / speed));
    }

    const stepStart = Date.now();
    try {
      const result = await Promise.race([
        ctx.handleTool(step.action, { ...step.args, platform: scenario.platform }, depth + 1),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Step timeout")), stepTimeout)),
      ]);

      const text = typeof result === "object" && result !== null && "text" in result
        ? truncateOutput((result as { text: string }).text, { maxChars: 200, maxLines: 5 })
        : "OK";

      results.push({
        step: i + 1, action: step.action, label: step.label,
        status: "OK", message: text, durationMs: Date.now() - stepStart,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const onError = step.onError ?? (stopOnFail ? "stop" : "skip");

      results.push({
        step: i + 1, action: step.action, label: step.label,
        status: "FAIL", message: truncateOutput(msg, { maxChars: 200, maxLines: 3 }),
        durationMs: Date.now() - stepStart,
      });

      if (onError === "stop") break;
      // "skip" — continue to next step
      // "retry" — retry once
      if (onError === "retry") {
        try {
          await ctx.handleTool(step.action, { ...step.args, platform: scenario.platform }, depth + 1);
          // Overwrite last result with success
          results[results.length - 1] = {
            step: i + 1, action: step.action, label: step.label,
            status: "OK", message: "OK (retry)", durationMs: Date.now() - stepStart,
          };
        } catch {
          // Retry also failed — keep the FAIL result
          if (stopOnFail) break;
        }
      }
    }
  }

  return { results, totalMs: Date.now() - playbackStart };
}

export function formatPlaybackResults(scenario: Scenario, results: PlaybackResult[], totalMs: number): string {
  const passed = results.filter(r => r.status === "OK").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const total = scenario.steps.length;

  const statusLine = failed > 0
    ? `Playback FAILED: ${scenario.name} (${scenario.platform}) — ${passed}/${total} OK, ${failed} FAILED (${totalMs}ms)`
    : `Playback OK: ${scenario.name} (${scenario.platform}) — ${passed}/${total} OK (${totalMs}ms)`;

  const lines = results.map(r => {
    const label = r.label ? ` (${r.label})` : "";
    return `  ${r.step}. ${r.action}${label}: ${r.status} — ${r.message} (${r.durationMs}ms)`;
  });

  return `${statusLine}\n\n${lines.join("\n")}`;
}
