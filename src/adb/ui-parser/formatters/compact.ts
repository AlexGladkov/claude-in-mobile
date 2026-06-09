import type { UiElement } from "../types.js";

/**
 * Compact format: only interactive elements, short one-line format.
 * Groups consecutive identical element types (e.g. "15x ListItem").
 */
export function formatUiTreeCompact(elements: UiElement[], maxElements: number): string {
  // Filter to interactive elements only
  const interactive = elements.filter(el =>
    el.clickable || el.scrollable ||
    el.className.includes("EditText") || el.className.includes("TextField") ||
    el.className.includes("TextInput")
  );

  if (interactive.length === 0) {
    return "No interactive elements found";
  }

  const lines: string[] = [];
  let i = 0;
  const limit = Math.min(interactive.length, maxElements);

  while (i < limit) {
    const el = interactive[i];
    const shortClass = el.className.split(".").pop() ?? el.className;

    // Check for consecutive identical class names with no text
    let groupCount = 1;
    while (
      i + groupCount < limit &&
      !el.text && !el.contentDesc &&
      interactive[i + groupCount].className === el.className &&
      !interactive[i + groupCount].text && !interactive[i + groupCount].contentDesc
    ) {
      groupCount++;
    }

    if (groupCount >= 3) {
      lines.push(`${groupCount}x ${shortClass}`);
      i += groupCount;
    } else {
      const label = el.text || el.contentDesc || "";
      const labelPart = label ? ` "${label.slice(0, 40)}${label.length > 40 ? "…" : ""}"` : "";
      lines.push(`[${el.index}] ${shortClass}${labelPart} (${el.centerX},${el.centerY})`);
      i++;
    }
  }

  if (interactive.length > maxElements) {
    lines.push(`(${maxElements} of ${interactive.length} interactive elements)`);
  }

  return lines.join("\n");
}
