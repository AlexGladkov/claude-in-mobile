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

/**
 * RecorderState — owns the previously module-level `activeRecording` slot
 * from `recorder-tools.ts`. The recorder tool handlers and `captureStep`
 * read/write the active recording through the default RuntimeContext.
 */
export class RecorderState {
  private active: RecordingState | null = null;

  get(): RecordingState | null {
    return this.active;
  }

  set(value: RecordingState | null): void {
    this.active = value;
  }

  isActive(): boolean {
    return this.active !== null;
  }
}
