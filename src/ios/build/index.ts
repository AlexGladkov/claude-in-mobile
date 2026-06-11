/**
 * iOS build + TestFlight upload pipeline.
 *
 * Typical flow:
 *   detectIosProject -> listSchemes -> pickReleaseScheme ->
 *   archiveApp -> writeExportOptionsPlist -> exportArchive -> uploadIpa
 * (Flutter projects short-circuit via buildFlutterIpa -> uploadIpa.)
 */

export {
  detectIosProject,
  listSchemes,
  pickReleaseScheme,
  xcodeTargetArgs,
  type ProjectInfo,
  type ProjectKind,
} from "./project-detector.js";
export {
  renderExportOptionsPlist,
  writeExportOptionsPlist,
  type ExportOptionsConfig,
} from "./export-options.js";
export {
  archiveApp,
  exportArchive,
  buildFlutterIpa,
  type AscApiAuth,
} from "./xcode-build.js";
export { uploadIpa, validateIpa } from "./upload.js";
export {
  bundleRejectHint,
  classifyXcodeError,
  redactSigningInfo,
} from "./classify-build-error.js";
