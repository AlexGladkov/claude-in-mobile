import type { ScenarioStep } from "../utils/scenario-store.js";

export interface RecordingState {
  name: string;
  platform: string;
  description: string;
  tags: string[];
  steps: ScenarioStep[];
  startedAt: number;
  lastStepAt: number;
}

export type RecorderStopOutcome = "saved" | "discarded" | "failed";

/**
 * RecorderState — owns the previously module-level `activeRecording` slot
 * from `recorder-tools.ts`. The recorder tool handlers and `captureStep`
 * read/write the active recording through the default RuntimeContext.
 */
export class RecorderState {
  private active: RecordingState | null = null;
  private startingName: string | null = null;
  private stopInProgress = false;

  get(): RecordingState | null {
    return this.active;
  }

  set(value: RecordingState | null): void {
    if (this.stopInProgress) {
      throw new Error("Cannot replace an active recording while it is being saved.");
    }
    this.startingName = null;
    this.active = value;
  }

  /**
   * Reserve the single recorder slot before async validation. Returns the
   * existing active/pending name when another start owns the slot.
   */
  reserveStart(name: string): string | undefined {
    const existingName = this.active?.name ?? this.startingName ?? undefined;
    if (existingName !== undefined) return existingName;
    this.startingName = name;
    return undefined;
  }

  activateStart(value: RecordingState): void {
    if (this.startingName !== value.name || this.active !== null || this.stopInProgress) {
      throw new Error("Recorder start reservation was lost.");
    }
    this.startingName = null;
    this.active = value;
  }

  cancelStart(name: string): void {
    if (this.startingName === name) this.startingName = null;
  }

  /**
   * Atomically transition the active recording into the save phase. The
   * recording remains active until finishStop confirms persistence, so a
   * failed save can be retried or discarded.
   */
  beginStop(): RecordingState | null {
    if (this.active === null || this.stopInProgress) return null;
    this.stopInProgress = true;
    return this.active;
  }

  /**
   * Finish a stop transition for the exact recording that began it. Failed
   * persistence releases the save guard but intentionally retains the active
   * recording for recovery.
   */
  finishStop(recording: RecordingState, outcome: RecorderStopOutcome): void {
    if (this.active !== recording || !this.stopInProgress) {
      throw new Error("Recorder stop reservation was lost.");
    }
    this.stopInProgress = false;
    if (outcome !== "failed") this.active = null;
  }

  isStopInProgress(): boolean {
    return this.stopInProgress;
  }

  isActive(): boolean {
    return this.active !== null;
  }
}
