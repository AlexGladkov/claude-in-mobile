// Thin facade — implementation lives in `./recorder/`.
//
// Kept as a stable import surface for:
//   - src/index.ts (captureStep)
//   - src/tools/meta/recorder-meta.ts (recorderTools)
//   - src/tools/recorder-tools.test.ts (captureStep, isRecording, recorderTools)
//
// Internals are split across `./recorder/{redaction,capture,playback,tools}.ts`.

export { captureStep, isRecording } from "./recorder/capture.js";
export { recorderTools } from "./recorder/tools.js";
export {
  RECORDING_BLOCKLIST,
  PLAYBACK_BLOCKED_ACTIONS,
} from "./recorder/redaction.js";
