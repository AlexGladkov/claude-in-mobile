import type { UiDiffResult, UiElement } from "./types.js";
import { getShortId } from "./types.js";

// ──────────────────────────────────────────────
// Action Result Hints — UI Element Diffing
// ──────────────────────────────────────────────

export function elementFingerprint(el: UiElement): string {
  return `${el.resourceId}|${el.text}|${el.className}`;
}

/**
 * Diff two sets of UI elements to detect changes.
 * Returns appeared/disappeared element descriptions and whether the screen changed significantly.
 */
export function diffUiElements(before: UiElement[], after: UiElement[]): UiDiffResult {
  const beforeSet = new Set(before.map(elementFingerprint));
  const afterSet = new Set(after.map(elementFingerprint));

  const appearedElements = after.filter(el => !beforeSet.has(elementFingerprint(el)));
  const disappearedElements = before.filter(el => !afterSet.has(elementFingerprint(el)));

  // If more than 60% of elements are different, consider it a screen change
  const totalUnique = new Set([...beforeSet, ...afterSet]).size;
  const changedCount = appearedElements.length + disappearedElements.length;
  const screenChanged = totalUnique > 0 && (changedCount / totalUnique) > 0.6;

  // Format descriptions (limit to 5 each)
  const describeEl = (el: UiElement): string => {
    const label = el.text || el.contentDesc || getShortId(el.resourceId) || "";
    const shortClass = el.className.split(".").pop() ?? el.className;
    if (label) {
      return el.clickable ? `"${label}" ${shortClass.toLowerCase()}` : `"${label}"`;
    }
    return shortClass;
  };

  return {
    screenChanged,
    appeared: appearedElements.slice(0, 5).map(describeEl).filter(s => s.length > 0),
    disappeared: disappearedElements.slice(0, 5).map(describeEl).filter(s => s.length > 0),
    beforeCount: before.length,
    afterCount: after.length,
  };
}

/**
 * Suggest next actions based on current UI state.
 */
export function suggestNextActions(elements: UiElement[]): string[] {
  const suggestions: string[] = [];

  // Focused input field
  const focusedInput = elements.find(el =>
    el.focused && (el.className.includes("EditText") || el.className.includes("TextField") ||
                   el.className.includes("TextInput"))
  );
  if (focusedInput) {
    const name = focusedInput.contentDesc || focusedInput.text || getShortId(focusedInput.resourceId) || "field";
    suggestions.push(`input_text into ${name}`);
  }

  // Dialog with OK/Cancel
  const dialogButtons = elements.filter(el =>
    el.clickable && el.enabled &&
    (el.text.match(/^(OK|Cancel|Yes|No|Confirm|Dismiss|Close|Accept|Deny|Allow|Don't allow)$/i) ||
     el.contentDesc.match(/^(OK|Cancel|Yes|No|Confirm|Dismiss|Close|Accept|Deny|Allow)$/i))
  );
  if (dialogButtons.length > 0) {
    const labels = dialogButtons.map(b => b.text || b.contentDesc).join(" or ");
    suggestions.push(`tap ${labels}`);
  }

  // New clickable elements (limit to 3)
  const clickableElements = elements.filter(el =>
    el.clickable && el.enabled && (el.text || el.contentDesc) && el.width > 10 && el.height > 10
  );
  if (clickableElements.length > 0 && suggestions.length < 3) {
    const labels = clickableElements.slice(0, 3).map(el =>
      `"${el.text || el.contentDesc}"`
    ).join(", ");
    suggestions.push(`tap ${labels}`);
  }

  // Scrollable area
  const scrollable = elements.find(el => el.scrollable);
  if (scrollable) {
    suggestions.push("scroll to see more");
  }

  return suggestions.slice(0, 4);
}
