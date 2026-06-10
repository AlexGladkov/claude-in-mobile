/**
 * UI inspection & interaction tools — thin facade over `./ui/*` handlers.
 *
 * Sub-tools:
 *   - ui_tree:           UI hierarchy dump
 *   - ui_find:           find elements by text/id/className
 *   - ui_find_tap:       fuzzy NL tap (Android)
 *   - ui_tap_text:       tap by text via Accessibility API (Desktop)
 *   - ui_analyze:        structured screen analysis
 *   - ui_wait:           wait for element with timeout
 *   - ui_assert_visible: assert element present
 *   - ui_assert_gone:    assert element absent
 */

import type { ToolDefinition } from "./registry.js";
import {
  uiTree,
  uiFind,
  uiFindTap,
  uiTapText,
  uiAnalyze,
  uiWait,
  uiAssertVisible,
  uiAssertGone,
} from "./ui/index.js";

export const uiTools: ToolDefinition[] = [
  uiTree,
  uiFind,
  uiFindTap,
  uiTapText,
  uiAnalyze,
  uiWait,
  uiAssertVisible,
  uiAssertGone,
];
