/**
 * UI parser facade — re-exports the split modules under `./ui-parser/`.
 * Original 954-LOC file was decomposed in D8.5; behaviour preserved.
 *
 * Layers:
 *   - node-parser:     raw XML / desktop-hierarchy text → UiElement[]
 *   - element-builder: UiElement[] queries, screen analysis, scoring, diffing
 *   - formatters/*:    UiElement[] → string (semantic / compact / full)
 */

// Types
export type { Bounds, UiElement, ScreenAnalysis, UiDiffResult } from "./ui-parser/types.js";

// Node parsing
export { parseUiHierarchy, desktopHierarchyToUiElements } from "./ui-parser/node-parser.js";

// Element queries, analysis, diffing
export {
  findByText,
  findByResourceId,
  findByClassName,
  findClickable,
  findElements,
  findClickableAncestor,
  findBestMatch,
  detectScreenTitle,
  detectDialog,
  detectNavigation,
  analyzeScreen,
  diffUiElements,
  suggestNextActions,
} from "./ui-parser/element-builder.js";

// Formatters
export {
  formatElement,
  formatUiTree,
  formatUiTreeCompact,
  formatUiTreeSemantic,
  formatScreenAnalysis,
  FORMATTERS,
} from "./ui-parser/formatters/index.js";
export type { Formatter } from "./ui-parser/formatters/index.js";
