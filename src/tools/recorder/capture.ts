import type { ScenarioStep } from "../../utils/scenario-store.js";
import { MAX_STEPS_PER_SCENARIO } from "../../utils/scenario-store.js";
import { getDefaultRuntimeContext } from "../../runtime/runtime-context.js";
import type { RecordingState } from "../recorder-state.js";
import {
  RECORDING_BLOCKLIST,
  classifyStepType,
  isSensitiveInput,
} from "./redaction.js";

// ── Active recording accessors (delegated to RecorderState in RuntimeContext) ──

export function getActive(): RecordingState | null {
  return getDefaultRuntimeContext().recorder.get();
}

export function setActive(v: RecordingState | null): void {
  getDefaultRuntimeContext().recorder.set(v);
}

// ── Public recording API (called from index.ts handleTool) ──

export function isRecording(): boolean {
  return getActive() !== null;
}

export function captureStep(action: string, args: Record<string, unknown>, depth: number): void {
  const activeRecording = getActive();
  if (!activeRecording) return;
  if (depth !== 0) return;
  if (RECORDING_BLOCKLIST.has(action)) return;
  if (activeRecording.steps.length >= MAX_STEPS_PER_SCENARIO) return;

  const now = Date.now();
  const delayBeforeMs = activeRecording.steps.length === 0
    ? 0
    : now - activeRecording.lastStepAt;

  const sensitive = isSensitiveInput(action, args);
  const cleanArgs = { ...args };
  // Remove platform — inherited from scenario
  delete cleanArgs.platform;
  if (sensitive) {
    if ("text" in cleanArgs) cleanArgs.text = "[REDACTED]";
    if ("value" in cleanArgs) cleanArgs.value = "[REDACTED]";
  }

  const step: ScenarioStep = {
    index: activeRecording.steps.length,
    type: classifyStepType(action),
    action,
    args: cleanArgs,
    timestampMs: now - activeRecording.startedAt,
    delayBeforeMs,
    ...(sensitive ? { sensitive: true } : {}),
  };

  activeRecording.steps.push(step);
  activeRecording.lastStepAt = now;
}
