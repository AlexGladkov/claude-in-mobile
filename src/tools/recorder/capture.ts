import type { ScenarioStep } from "../../utils/scenario-store.js";
import { MAX_STEPS_PER_SCENARIO } from "../../utils/scenario-store.js";
import { getDefaultRuntimeContext } from "../../runtime/runtime-context.js";
import type { RecorderStopOutcome, RecordingState } from "../recorder-state.js";
import {
  classifyStepType,
  isRecordingBlockedAction,
  redactSensitiveArgs,
} from "./redaction.js";

// ── Active recording accessors (delegated to RecorderState in RuntimeContext) ──

export function getActive(): RecordingState | null {
  return getDefaultRuntimeContext().recorder.get();
}

export function setActive(v: RecordingState | null): void {
  getDefaultRuntimeContext().recorder.set(v);
}

export function reserveStart(name: string): string | undefined {
  return getDefaultRuntimeContext().recorder.reserveStart(name);
}

export function activateStart(recording: RecordingState): void {
  getDefaultRuntimeContext().recorder.activateStart(recording);
}

export function cancelStart(name: string): void {
  getDefaultRuntimeContext().recorder.cancelStart(name);
}

export function beginStop(): RecordingState | null {
  return getDefaultRuntimeContext().recorder.beginStop();
}

export function finishStop(recording: RecordingState, outcome: RecorderStopOutcome): void {
  getDefaultRuntimeContext().recorder.finishStop(recording, outcome);
}

export function isStopInProgress(): boolean {
  return getDefaultRuntimeContext().recorder.isStopInProgress();
}

// ── Public recording API (called from index.ts handleTool) ──

export function isRecording(): boolean {
  return getActive() !== null;
}

export function captureStep(action: string, args: Record<string, unknown>, depth: number): void {
  const recorder = getDefaultRuntimeContext().recorder;
  const activeRecording = recorder.get();
  if (!activeRecording || recorder.isStopInProgress()) return;
  if (depth !== 0) return;
  if (isRecordingBlockedAction(action, args)) return;
  if (activeRecording.steps.length >= MAX_STEPS_PER_SCENARIO) return;

  const now = Date.now();
  const delayBeforeMs = activeRecording.steps.length === 0
    ? 0
    : now - activeRecording.lastStepAt;

  const { args: cleanArgs, sensitive } = redactSensitiveArgs(action, args);
  // Remove platform — inherited from scenario
  delete cleanArgs.platform;

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
