import type { ScreenAnalysis, UiElement } from "./types.js";
import { getShortId } from "./types.js";

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
    void text;

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
 * Analyze screen and return structured information.
 * More useful than raw UI tree for Claude to understand.
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
