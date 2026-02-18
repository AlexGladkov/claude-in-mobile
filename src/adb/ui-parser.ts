export interface Bounds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface UiElement {
  index: number;
  resourceId: string;
  className: string;
  packageName: string;
  text: string;
  contentDesc: string;
  checkable: boolean;
  checked: boolean;
  clickable: boolean;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  scrollable: boolean;
  longClickable: boolean;
  password: boolean;
  selected: boolean;
  bounds: Bounds;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

/**
 * Parse UI hierarchy XML from uiautomator dump
 */
export function parseUiHierarchy(xml: string): UiElement[] {
  const elements: UiElement[] = [];
  const nodeRegex = /<node[^>]+>/g;

  let match;
  let index = 0;

  while ((match = nodeRegex.exec(xml)) !== null) {
    const nodeStr = match[0];

    // Parse bounds
    const boundsMatch = nodeStr.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!boundsMatch) continue;

    const bounds: Bounds = {
      x1: parseInt(boundsMatch[1]),
      y1: parseInt(boundsMatch[2]),
      x2: parseInt(boundsMatch[3]),
      y2: parseInt(boundsMatch[4])
    };

    const element: UiElement = {
      index: index++,
      resourceId: extractAttr(nodeStr, "resource-id"),
      className: extractAttr(nodeStr, "class"),
      packageName: extractAttr(nodeStr, "package"),
      text: extractAttr(nodeStr, "text"),
      contentDesc: extractAttr(nodeStr, "content-desc"),
      checkable: extractAttr(nodeStr, "checkable") === "true",
      checked: extractAttr(nodeStr, "checked") === "true",
      clickable: extractAttr(nodeStr, "clickable") === "true",
      enabled: extractAttr(nodeStr, "enabled") === "true",
      focusable: extractAttr(nodeStr, "focusable") === "true",
      focused: extractAttr(nodeStr, "focused") === "true",
      scrollable: extractAttr(nodeStr, "scrollable") === "true",
      longClickable: extractAttr(nodeStr, "long-clickable") === "true",
      password: extractAttr(nodeStr, "password") === "true",
      selected: extractAttr(nodeStr, "selected") === "true",
      bounds,
      centerX: Math.floor((bounds.x1 + bounds.x2) / 2),
      centerY: Math.floor((bounds.y1 + bounds.y2) / 2),
      width: bounds.x2 - bounds.x1,
      height: bounds.y2 - bounds.y1
    };

    elements.push(element);
  }

  return elements;
}

/**
 * Extract attribute value from node string
 */
function extractAttr(nodeStr: string, attrName: string): string {
  const regex = new RegExp(`${attrName}="([^"]*)"`);
  const match = nodeStr.match(regex);
  return match?.[1] ?? "";
}

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
 * Format element for display
 */
export function formatElement(el: UiElement): string {
  const parts: string[] = [];
  const shortClass = el.className.split(".").pop() ?? el.className;

  parts.push(`[${el.index}]`);
  parts.push(`<${shortClass}>`);

  if (el.resourceId) {
    const shortId = el.resourceId.split(":id/").pop() ?? el.resourceId;
    parts.push(`id="${shortId}"`);
  }

  if (el.text) {
    parts.push(`text="${el.text.slice(0, 50)}${el.text.length > 50 ? "..." : ""}"`);
  }

  if (el.contentDesc) {
    parts.push(`desc="${el.contentDesc.slice(0, 30)}${el.contentDesc.length > 30 ? "..." : ""}"`);
  }

  const flags: string[] = [];
  if (el.clickable) flags.push("clickable");
  if (el.scrollable) flags.push("scrollable");
  if (el.focused) flags.push("focused");
  if (el.checked) flags.push("checked");
  if (!el.enabled) flags.push("disabled");

  if (flags.length > 0) {
    parts.push(`(${flags.join(", ")})`);
  }

  parts.push(`@ (${el.centerX}, ${el.centerY})`);

  return parts.join(" ");
}

/**
 * Format UI tree for display (simplified view)
 */
export function formatUiTree(elements: UiElement[], options?: {
  showAll?: boolean;
  maxElements?: number;
}): string {
  const { showAll = false, maxElements = 100 } = options ?? {};

  // Filter to only meaningful elements
  let filtered = showAll
    ? elements
    : elements.filter(el =>
        el.text ||
        el.contentDesc ||
        el.clickable ||
        el.scrollable ||
        el.focusable ||
        el.resourceId.includes(":id/")
      );

  if (filtered.length > maxElements) {
    filtered = filtered.slice(0, maxElements);
  }

  if (filtered.length === 0) {
    return "No UI elements found";
  }

  return filtered.map(formatElement).join("\n");
}

/**
 * Screen analysis result
 */
export interface ScreenAnalysis {
  /** Current activity/screen name */
  activity?: string;
  /** Detected screen title (from Toolbar/NavigationBar) */
  screenTitle?: string;
  /** Whether a dialog/modal is detected */
  hasDialog?: boolean;
  /** Dialog title if detected */
  dialogTitle?: string;
  /** Navigation state */
  navigationState?: {
    hasBack: boolean;
    hasMenu: boolean;
    hasTabs: boolean;
    currentTab?: string;
  };
  /** Buttons and clickable elements */
  buttons: Array<{
    index: number;
    label: string;
    coordinates: { x: number; y: number };
  }>;
  /** Text input fields */
  inputs: Array<{
    index: number;
    hint: string;
    value: string;
    coordinates: { x: number; y: number };
  }>;
  /** Static text on screen */
  texts: Array<{
    content: string;
    coordinates: { x: number; y: number };
  }>;
  /** Scrollable containers */
  scrollable: Array<{
    index: number;
    direction: "vertical" | "horizontal" | "both";
    coordinates: { x: number; y: number };
  }>;
  /** Summary for quick understanding */
  summary: string;
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
 * Convert desktop UI hierarchy text to UiElement[] for cross-platform analysis.
 * Desktop hierarchy is pre-formatted text from the companion app.
 * Format: indented lines like "  <Button> text="Click me" @ (100, 200) [50x30]"
 */
export function desktopHierarchyToUiElements(hierarchyText: string): UiElement[] {
  const elements: UiElement[] = [];
  const lines = hierarchyText.split("\n");
  let index = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("─") || trimmed.startsWith("=")) continue;

    // Try to extract element info from formatted line
    const classMatch = trimmed.match(/<(\w+)>/);
    const textMatch = trimmed.match(/text="([^"]*)"/);
    const labelMatch = trimmed.match(/label="([^"]*)"/);
    const valueMatch = trimmed.match(/value="([^"]*)"/);
    const idMatch = trimmed.match(/id="([^"]*)"/);
    const coordMatch = trimmed.match(/@ \((\d+),\s*(\d+)\)/);
    const sizeMatch = trimmed.match(/\[(\d+)x(\d+)\]/);
    const roleMatch = trimmed.match(/role="([^"]*)"/);

    if (!classMatch && !textMatch && !coordMatch) continue;

    const className = classMatch?.[1] ?? "";
    const text = textMatch?.[1] ?? labelMatch?.[1] ?? valueMatch?.[1] ?? "";
    const x = coordMatch ? parseInt(coordMatch[1]) : 0;
    const y = coordMatch ? parseInt(coordMatch[2]) : 0;
    const w = sizeMatch ? parseInt(sizeMatch[1]) : 100;
    const h = sizeMatch ? parseInt(sizeMatch[2]) : 40;
    const role = roleMatch?.[1] ?? "";

    const isClickable = role.includes("button") || role.includes("link") ||
      className.includes("Button") || className.includes("Link") ||
      className.includes("MenuItem") || trimmed.includes("clickable");
    const isScrollable = className.includes("ScrollView") || className.includes("List") ||
      role.includes("scroll");
    const isFocused = trimmed.includes("focused");
    const isInput = className.includes("TextField") || className.includes("TextInput") ||
      className.includes("EditText") || role.includes("textfield") || role.includes("textarea");

    elements.push({
      index: index++,
      resourceId: idMatch?.[1] ?? "",
      className,
      packageName: "",
      text,
      contentDesc: "",
      checkable: false,
      checked: false,
      clickable: isClickable,
      enabled: !trimmed.includes("disabled"),
      focusable: isClickable || isInput,
      focused: isFocused,
      scrollable: isScrollable,
      longClickable: false,
      password: className.includes("SecureTextField") || className.includes("Password"),
      selected: trimmed.includes("selected"),
      bounds: { x1: x, y1: y, x2: x + w, y2: y + h },
      centerX: Math.floor(x + w / 2),
      centerY: Math.floor(y + h / 2),
      width: w,
      height: h,
    });
  }

  return elements;
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
 * Get short ID from resource ID
 */
function getShortId(resourceId: string): string {
  if (!resourceId) return "";
  return resourceId.split(":id/").pop() ?? resourceId;
}

/**
 * Find best element by description (smart fuzzy search)
 * Returns the best match or null
 */
export function findBestMatch(
  elements: UiElement[],
  description: string
): { element: UiElement; confidence: number; reason: string } | null {
  const desc = description.toLowerCase().trim();

  // Score each element
  const scored = elements
    .filter(el => el.enabled && (el.width > 0 && el.height > 0))
    .map(el => {
      let score = 0;
      let reason = "";

      const text = el.text.toLowerCase();
      const contentDesc = el.contentDesc.toLowerCase();
      const id = getShortId(el.resourceId).toLowerCase().replace(/_/g, " ");

      // Exact text match
      if (text === desc) {
        score = 100;
        reason = `exact text match: "${el.text}"`;
      }
      // Exact content description match
      else if (contentDesc === desc) {
        score = 95;
        reason = `exact description: "${el.contentDesc}"`;
      }
      // Text contains description
      else if (text.includes(desc)) {
        score = 80;
        reason = `text contains: "${el.text}"`;
      }
      // Content description contains
      else if (contentDesc.includes(desc)) {
        score = 75;
        reason = `description contains: "${el.contentDesc}"`;
      }
      // ID match (common patterns like btn_submit, button_ok)
      else if (id.includes(desc) || id.includes(desc.replace(/ /g, "_"))) {
        score = 60;
        reason = `ID match: "${el.resourceId}"`;
      }
      // Partial word match in text
      else if (desc.split(" ").some(word => text.includes(word) && word.length > 2)) {
        score = 40;
        reason = `partial text match: "${el.text}"`;
      }
      // Partial word match in description
      else if (desc.split(" ").some(word => contentDesc.includes(word) && word.length > 2)) {
        score = 35;
        reason = `partial description match: "${el.contentDesc}"`;
      }

      // Boost clickable elements
      if (score > 0 && el.clickable) {
        score += 10;
      }

      return { element: el, score, reason };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return null;
  }

  const best = scored[0];
  return {
    element: best.element,
    confidence: Math.min(best.score, 100),
    reason: best.reason
  };
}

/**
 * Format screen analysis as text
 */
export function formatScreenAnalysis(analysis: ScreenAnalysis): string {
  const lines: string[] = [];

  lines.push(`=== Screen Analysis ===`);
  lines.push(analysis.summary);
  lines.push("");

  if (analysis.screenTitle) {
    lines.push(`Title: "${analysis.screenTitle}"`);
  }
  if (analysis.hasDialog) {
    lines.push(`Dialog: "${analysis.dialogTitle ?? "untitled"}"`);
  }
  if (analysis.navigationState) {
    const nav = analysis.navigationState;
    const parts: string[] = [];
    if (nav.hasBack) parts.push("Back");
    if (nav.hasMenu) parts.push("Menu");
    if (nav.hasTabs) parts.push(`Tabs${nav.currentTab ? ` [${nav.currentTab}]` : ""}`);
    lines.push(`Navigation: ${parts.join(", ")}`);
  }
  if (analysis.screenTitle || analysis.hasDialog || analysis.navigationState) {
    lines.push("");
  }

  if (analysis.buttons.length > 0) {
    lines.push(`Buttons (${analysis.buttons.length}):`);
    for (const btn of analysis.buttons.slice(0, 15)) {
      lines.push(`  [${btn.index}] "${btn.label}" @ (${btn.coordinates.x}, ${btn.coordinates.y})`);
    }
    if (analysis.buttons.length > 15) {
      lines.push(`  ... and ${analysis.buttons.length - 15} more`);
    }
    lines.push("");
  }

  if (analysis.inputs.length > 0) {
    lines.push(`Input fields (${analysis.inputs.length}):`);
    for (const inp of analysis.inputs) {
      const value = inp.value ? ` = "${inp.value}"` : " (empty)";
      lines.push(`  [${inp.index}] ${inp.hint || "text field"}${value} @ (${inp.coordinates.x}, ${inp.coordinates.y})`);
    }
    lines.push("");
  }

  if (analysis.texts.length > 0) {
    lines.push(`Text on screen:`);
    for (const txt of analysis.texts.slice(0, 10)) {
      lines.push(`  "${txt.content.slice(0, 60)}${txt.content.length > 60 ? "..." : ""}"`);
    }
    if (analysis.texts.length > 10) {
      lines.push(`  ... and ${analysis.texts.length - 10} more`);
    }
  }

  return lines.join("\n");
}

// ──────────────────────────────────────────────
// Action Result Hints — UI Element Diffing
// ──────────────────────────────────────────────

export interface UiDiffResult {
  screenChanged: boolean;
  appeared: string[];
  disappeared: string[];
  beforeCount: number;
  afterCount: number;
}

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
