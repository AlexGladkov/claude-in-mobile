import type { Bounds, UiElement } from "./types.js";

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

const ATTR_REGEXES: Record<string, RegExp> = {
  "resource-id": /resource-id="([^"]*)"/,
  "class": /class="([^"]*)"/,
  "package": /package="([^"]*)"/,
  "text": /text="([^"]*)"/,
  "content-desc": /content-desc="([^"]*)"/,
  "checkable": /checkable="([^"]*)"/,
  "checked": /checked="([^"]*)"/,
  "clickable": /clickable="([^"]*)"/,
  "enabled": /enabled="([^"]*)"/,
  "focusable": /focusable="([^"]*)"/,
  "focused": /focused="([^"]*)"/,
  "scrollable": /scrollable="([^"]*)"/,
  "long-clickable": /long-clickable="([^"]*)"/,
  "password": /password="([^"]*)"/,
  "selected": /selected="([^"]*)"/,
};

/**
 * Extract attribute value from node string
 */
function extractAttr(nodeStr: string, attrName: string): string {
  const regex = ATTR_REGEXES[attrName];
  if (!regex) return "";
  const match = nodeStr.match(regex);
  return match?.[1] ?? "";
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
