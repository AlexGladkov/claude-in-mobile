import { scoreElement } from "../ui-scoring.js";
import type { ScreenAnalysis, UiDiffResult, UiElement } from "./types.js";
import { getShortId } from "./types.js";

/**
 * Find elements by text (partial match, case-insensitive)
 */
export function findByText(elements: UiElement[], text: string): UiElement[] {
  const lowerText = text.toLowerCase();
  return elements.filter(el =>
    el.text.toLowerCase().includes(lowerText) ||
    el.contentDesc.toLowerCase().includes(lowerText)
  );
}

/**
 * Find elements by resource ID (partial match)
 */
export function findByResourceId(elements: UiElement[], id: string): UiElement[] {
  return elements.filter(el => el.resourceId.includes(id));
}

/**
 * Find elements by class name
 */
export function findByClassName(elements: UiElement[], className: string): UiElement[] {
  return elements.filter(el => el.className.includes(className));
}

/**
 * Find clickable elements
 */
export function findClickable(elements: UiElement[]): UiElement[] {
  return elements.filter(el => el.clickable);
}

/**
 * Find elements by multiple criteria
 */
export function findElements(
  elements: UiElement[],
  criteria: {
    text?: string;
    resourceId?: string;
    className?: string;
    clickable?: boolean;
    enabled?: boolean;
    visible?: boolean;
  }
): UiElement[] {
  return elements.filter(el => {
    if (criteria.text && !el.text.toLowerCase().includes(criteria.text.toLowerCase()) &&
        !el.contentDesc.toLowerCase().includes(criteria.text.toLowerCase())) {
      return false;
    }
    if (criteria.resourceId && !el.resourceId.includes(criteria.resourceId)) {
      return false;
    }
    if (criteria.className && !el.className.includes(criteria.className)) {
      return false;
    }
    if (criteria.clickable !== undefined && el.clickable !== criteria.clickable) {
      return false;
    }
    if (criteria.enabled !== undefined && el.enabled !== criteria.enabled) {
      return false;
    }
    if (criteria.visible !== undefined) {
      const isVisible = el.width > 0 && el.height > 0;
      if (isVisible !== criteria.visible) return false;
    }
    return true;
  });
}

/**
 * Detect screen title from Toolbar/ActionBar/NavigationBar elements
 */
export function detectScreenTitle(elements: UiElement[]): string | undefined {
  // Look for text within Toolbar, ActionBar, or NavigationBar containers
  const toolbarClasses = ["Toolbar", "ActionBar", "NavigationBar", "Header"];
  for (const el of elements) {
    const className = el.className;
    const isToolbar = toolbarClasses.some(tc => className.includes(tc));
    if (isToolbar && el.text) {
      return el.text;
    }
  }
  // Fallback: look for a prominent text near the top of the screen (y < 200, large width)
  for (const el of elements) {
    if (el.text && !el.clickable && el.bounds.y1 < 200 && el.width > 200 &&
        (el.className.includes("TextView") || el.className.includes("StaticText"))) {
      return el.text;
    }
  }
  return undefined;
}

/**
 * Detect if a dialog/modal is present and return its title
 */
export function detectDialog(elements: UiElement[]): { hasDialog: boolean; dialogTitle?: string } {
  const dialogClasses = ["AlertDialog", "Dialog", "BottomSheet", "Modal", "Popup", "Alert"];
  for (const el of elements) {
    if (dialogClasses.some(dc => el.className.includes(dc))) {
      // Find the first text child that could be the title
      const titleEl = elements.find(child =>
        child.text &&
        child.bounds.y1 >= el.bounds.y1 &&
        child.bounds.y2 <= el.bounds.y2 &&
        child.bounds.x1 >= el.bounds.x1 &&
        child.bounds.x2 <= el.bounds.x2 &&
        (child.className.includes("TextView") || child.className.includes("StaticText"))
      );
      return { hasDialog: true, dialogTitle: titleEl?.text };
    }
  }
  // Heuristic: overlay-like element covering most of the screen with a smaller card inside
  const screenArea = elements.length > 0
    ? Math.max(...elements.map(el => el.width * el.height))
    : 0;
  for (const el of elements) {
    if (el.className.includes("FrameLayout") || el.className.includes("View")) {
      const area = el.width * el.height;
      if (area > screenArea * 0.3 && area < screenArea * 0.85 &&
          el.bounds.y1 > 100 && el.bounds.x1 > 20) {
        // Looks like a dialog card
        const titleEl = elements.find(child =>
          child.text && !child.clickable &&
          child.bounds.y1 >= el.bounds.y1 &&
          child.bounds.y2 <= el.bounds.y2 &&
          child.bounds.x1 >= el.bounds.x1 &&
          child.bounds.x2 <= el.bounds.x2
        );
        if (titleEl) {
          return { hasDialog: true, dialogTitle: titleEl.text };
        }
      }
    }
  }
  return { hasDialog: false };
}

/**
 * Detect navigation state (back button, menu, tabs)
 */
export function detectNavigation(elements: UiElement[]): {
  hasBack: boolean;
  hasMenu: boolean;
  hasTabs: boolean;
  currentTab?: string;
} {
  let hasBack = false;
  let hasMenu = false;
  let hasTabs = false;
  let currentTab: string | undefined;

  for (const el of elements) {
    const desc = (el.contentDesc || "").toLowerCase();
    const id = (el.resourceId || "").toLowerCase();
    const text = (el.text || "").toLowerCase();

    // Back button detection
    if (desc.includes("back") || desc.includes("navigate up") ||
        id.includes("back") || id.includes("navigate_up") ||
        desc === "back" || el.className.includes("BackButton")) {
      hasBack = true;
    }

    // Menu/hamburger detection
    if (desc.includes("menu") || desc.includes("more options") ||
        desc.includes("overflow") || id.includes("menu") ||
        id.includes("overflow") || id.includes("hamburger")) {
      hasMenu = true;
    }

    // Tab detection
    if (el.className.includes("TabLayout") || el.className.includes("TabBar") ||
        el.className.includes("BottomNavigation") || el.className.includes("TabView") ||
        id.includes("tab_layout") || id.includes("bottom_nav") ||
        id.includes("tab_bar")) {
      hasTabs = true;
    }

    // Selected tab
    if (el.selected && hasTabs && el.text) {
      currentTab = el.text;
    }
    if (el.selected && (el.className.includes("Tab") || id.includes("tab")) && el.text) {
      hasTabs = true;
      currentTab = el.text;
    }
  }

  return { hasBack, hasMenu, hasTabs, currentTab };
}

/**
 * Analyze screen and return structured information
 * More useful than raw UI tree for Claude to understand
 */
export function analyzeScreen(elements: UiElement[], activity?: string): ScreenAnalysis {
  const buttons: ScreenAnalysis["buttons"] = [];
  const inputs: ScreenAnalysis["inputs"] = [];
  const texts: ScreenAnalysis["texts"] = [];
  const scrollable: ScreenAnalysis["scrollable"] = [];

  for (const el of elements) {
    // Skip invisible elements
    if (el.width <= 0 || el.height <= 0) continue;

    // Buttons and clickable elements
    if (el.clickable && el.enabled) {
      const label = el.text || el.contentDesc || getShortId(el.resourceId) || "";
      if (label) {
        buttons.push({
          index: el.index,
          label,
          coordinates: { x: el.centerX, y: el.centerY }
        });
      }
    }

    // Input fields — cross-platform: Android EditText, iOS TextField/SecureTextField
    if (el.className.includes("EditText") || el.className.includes("TextInputEditText") ||
        el.className.includes("TextField") || el.className.includes("TextInput") ||
        el.className.includes("SecureTextField")) {
      inputs.push({
        index: el.index,
        hint: el.contentDesc || getShortId(el.resourceId) || "",
        value: el.text,
        coordinates: { x: el.centerX, y: el.centerY }
      });
    }

    // Static text — cross-platform: Android TextView, iOS StaticText
    if (el.text && !el.clickable &&
        (el.className.includes("TextView") || el.className.includes("StaticText") ||
         el.className.includes("Label"))) {
      texts.push({
        content: el.text,
        coordinates: { x: el.centerX, y: el.centerY }
      });
    }

    // Scrollable containers
    if (el.scrollable) {
      const isVertical = el.height > el.width;
      scrollable.push({
        index: el.index,
        direction: isVertical ? "vertical" : "horizontal",
        coordinates: { x: el.centerX, y: el.centerY }
      });
    }
  }

  // Detect semantic features
  const screenTitle = detectScreenTitle(elements);
  const dialogInfo = detectDialog(elements);
  const navigationState = detectNavigation(elements);

  // Create summary
  const summaryParts: string[] = [];
  if (activity) {
    summaryParts.push(`Screen: ${activity.split(".").pop()}`);
  } else if (screenTitle) {
    summaryParts.push(`Screen: ${screenTitle}`);
  }
  if (dialogInfo.hasDialog) {
    summaryParts.push(`Dialog: "${dialogInfo.dialogTitle ?? "untitled"}"`);
  }
  if (buttons.length > 0) {
    summaryParts.push(`${buttons.length} buttons: ${buttons.slice(0, 5).map(b => `"${b.label}"`).join(", ")}${buttons.length > 5 ? "..." : ""}`);
  }
  if (inputs.length > 0) {
    summaryParts.push(`${inputs.length} input field(s)`);
  }
  if (scrollable.length > 0) {
    summaryParts.push(`Scrollable: ${scrollable[0].direction}`);
  }
  if (navigationState.hasBack || navigationState.hasMenu || navigationState.hasTabs) {
    const navParts: string[] = [];
    if (navigationState.hasBack) navParts.push("back");
    if (navigationState.hasMenu) navParts.push("menu");
    if (navigationState.hasTabs) navParts.push(`tabs${navigationState.currentTab ? `(${navigationState.currentTab})` : ""}`);
    summaryParts.push(`Nav: ${navParts.join(", ")}`);
  }

  return {
    activity,
    screenTitle,
    hasDialog: dialogInfo.hasDialog || undefined,
    dialogTitle: dialogInfo.dialogTitle,
    navigationState: (navigationState.hasBack || navigationState.hasMenu || navigationState.hasTabs)
      ? navigationState : undefined,
    buttons,
    inputs,
    texts: texts.slice(0, 20), // Limit text count
    scrollable,
    summary: summaryParts.join(" | ") || "Empty screen"
  };
}

/**
 * Find best element by description (smart fuzzy search)
 * Returns the best match or null
 */
/**
 * Find the smallest clickable ancestor whose bounds fully contain the target element.
 * Useful for grid/list items where the visible label (TextView) is non-clickable but
 * the parent ViewGroup carries the TapGestureRecognizer.
 *
 * Returns null if no clickable ancestor exists, or if the only candidate is so large
 * it likely covers the whole screen (heuristic: >75% of any screen dimension).
 */
export function findClickableAncestor(
  target: UiElement,
  all: UiElement[],
  options?: { maxAreaMultiplier?: number }
): UiElement | null {
  if (target.clickable) return null; // already clickable, no walk needed
  const targetArea = Math.max(1, target.width * target.height);
  const maxAreaMultiplier = options?.maxAreaMultiplier ?? 200; // ancestor area ≤ 200× target
  const candidates = all.filter(el =>
    el !== target &&
    el.clickable &&
    el.enabled &&
    el.width > 0 &&
    el.height > 0 &&
    // bounds containment
    el.bounds.x1 <= target.bounds.x1 &&
    el.bounds.y1 <= target.bounds.y1 &&
    el.bounds.x2 >= target.bounds.x2 &&
    el.bounds.y2 >= target.bounds.y2 &&
    // not the whole-screen container
    el.width * el.height <= targetArea * maxAreaMultiplier
  );
  if (candidates.length === 0) return null;
  // smallest by area = most specific ancestor
  candidates.sort((a, b) => (a.width * a.height) - (b.width * b.height));
  return candidates[0];
}

export function findBestMatch(
  elements: UiElement[],
  description: string,
  options?: { walkToClickable?: boolean }
): { element: UiElement; confidence: number; reason: string } | null {
  const desc = description.toLowerCase().trim();

  // Score each element via the declarative table in `ui-scoring.ts`.
  const scored = elements
    .filter(el => el.enabled && (el.width > 0 && el.height > 0))
    .map(el => {
      const text = el.text.toLowerCase();
      const contentDesc = el.contentDesc.toLowerCase();
      const id = getShortId(el.resourceId).toLowerCase().replace(/_/g, " ");
      const { score, reason } = scoreElement({ text, contentDesc, id, desc, element: el });
      return { element: el, score, reason };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return null;
  }

  const best = scored[0];

  // If matched element isn't clickable, try walking up to a clickable ancestor.
  // Common pattern: grid/list item where visible label is a TextView but the parent
  // ViewGroup owns the TapGestureRecognizer (frequent in MAUI/Compose layouts).
  // Default ON; caller can opt out with walkToClickable: false.
  const walkToClickable = options?.walkToClickable ?? true;
  if (walkToClickable && !best.element.clickable) {
    const ancestor = findClickableAncestor(best.element, elements);
    if (ancestor) {
      return {
        element: ancestor,
        confidence: Math.min(best.score, 95),
        reason: `${best.reason} (via clickable ancestor)`
      };
    }
  }

  return {
    element: best.element,
    confidence: Math.min(best.score, 100),
    reason: best.reason
  };
}

// ──────────────────────────────────────────────
// Action Result Hints — UI Element Diffing
// ──────────────────────────────────────────────

function elementFingerprint(el: UiElement): string {
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
