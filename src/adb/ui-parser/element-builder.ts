/**
 * Barrel re-export — preserves the historical `element-builder.ts` import path.
 *
 * After D9.3 the actual logic lives in three focused modules:
 *   - element-finders:  find* queries + smart fuzzy matching
 *   - screen-analyzer:  detect* / analyzeScreen — semantic screen summary
 *   - diff-engine:      diffUiElements / suggestNextActions — action hints
 */

export {
  findByText,
  findByResourceId,
  findByClassName,
  findClickable,
  findElements,
  findClickableAncestor,
  findBestMatch,
} from "./element-finders.js";

export {
  detectScreenTitle,
  detectDialog,
  detectNavigation,
  analyzeScreen,
} from "./screen-analyzer.js";

export {
  diffUiElements,
  suggestNextActions,
  elementFingerprint,
} from "./diff-engine.js";
