import type { UiElement } from "../types.js";
import { formatUiTreeSemantic } from "./semantic.js";
import { formatUiTreeCompact } from "./compact.js";
import { formatUiTree } from "./full.js";

export { formatUiTreeSemantic } from "./semantic.js";
export { formatUiTreeCompact } from "./compact.js";
export { formatUiTree, formatElement, formatScreenAnalysis } from "./full.js";

export type Formatter = (elements: UiElement[]) => string;

/** Strategy registry — name → formatter taking only elements (default options). */
export const FORMATTERS: { semantic: Formatter; compact: Formatter; full: Formatter } = {
  semantic: (elements) => formatUiTreeSemantic(elements),
  compact: (elements) => formatUiTreeCompact(elements, 100),
  full: (elements) => formatUiTree(elements),
};
