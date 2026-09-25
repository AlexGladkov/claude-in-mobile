import type { ScreenAnalysis, UiElement } from "../types.js";
import { formatUiTreeCompact } from "./compact.js";
import { isSecureElement, isSensitiveElement, REDACTED } from "./redact.js";
import { safeTerminalText } from "../../../utils/terminal-controls.js";

/**
 * Format element for display
 */
export function formatElement(el: UiElement): string {
  const parts: string[] = [];
  const shortClass = safeTerminalText(el.className.split(".").pop() ?? el.className);
  const secure = isSecureElement(el);
  const sensitiveId = isSensitiveElement(el);

  parts.push(`[${el.index}]`);
  parts.push(`<${shortClass}>`);

  if (el.resourceId) {
    const resourceId = sensitiveId ? REDACTED : safeTerminalText(el.resourceId);
    const shortId = resourceId.split(":id/").pop() ?? resourceId;
    parts.push(`id="${shortId}"`);
  }

  if (secure) {
    // Never leak the contents of a password / secure text field.
    parts.push(`text="${REDACTED}"`);
  } else if (el.text) {
    const text = safeTerminalText(el.text);
    parts.push(`text="${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`);
  }

  if (el.contentDesc) {
    const desc = secure
      ? REDACTED
      : safeTerminalText(el.contentDesc);
    const truncatedDesc = `${desc.slice(0, 30)}${desc.length > 30 ? "..." : ""}`;
    parts.push(`desc="${truncatedDesc}"`);
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
  compact?: boolean;
}): string {
  const { showAll = false, maxElements = 100, compact = false } = options ?? {};

  if (compact) {
    return formatUiTreeCompact(elements, maxElements);
  }

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

  const totalFiltered = filtered.length;
  if (filtered.length > maxElements) {
    filtered = filtered.slice(0, maxElements);
  }

  if (filtered.length === 0) {
    return "No UI elements found";
  }

  let result = filtered.map(formatElement).join("\n");
  if (totalFiltered > maxElements) {
    result += `\n(showing ${maxElements} of ${totalFiltered} elements, use showAll:false to filter)`;
  }
  return result;
}

/**
 * Format screen analysis as text
 */
export function formatScreenAnalysis(analysis: ScreenAnalysis): string {
  const lines: string[] = [];

  lines.push("=== Screen Analysis ===");
  lines.push(safeTerminalText(analysis.summary));
  lines.push("");

  if (analysis.screenTitle) {
    lines.push(`Title: "${safeTerminalText(analysis.screenTitle)}"`);
  }
  if (analysis.hasDialog) {
    lines.push(`Dialog: "${safeTerminalText(analysis.dialogTitle ?? "untitled")}"`);
  }
  if (analysis.navigationState) {
    const nav = analysis.navigationState;
    const parts: string[] = [];
    if (nav.hasBack) parts.push("Back");
    if (nav.hasMenu) parts.push("Menu");
    if (nav.hasTabs) {
      parts.push(`Tabs${nav.currentTab ? ` [${safeTerminalText(nav.currentTab)}]` : ""}`);
    }
    lines.push(`Navigation: ${parts.join(", ")}`);
  }
  if (analysis.screenTitle || analysis.hasDialog || analysis.navigationState) {
    lines.push("");
  }

  if (analysis.buttons.length > 0) {
    lines.push(`Buttons (${analysis.buttons.length}):`);
    for (const btn of analysis.buttons.slice(0, 15)) {
      lines.push(`  [${btn.index}] "${safeTerminalText(btn.label)}" @ (${btn.coordinates.x}, ${btn.coordinates.y})`);
    }
    if (analysis.buttons.length > 15) {
      lines.push(`  ... and ${analysis.buttons.length - 15} more`);
    }
    lines.push("");
  }

  if (analysis.inputs.length > 0) {
    lines.push(`Input fields (${analysis.inputs.length}):`);
    for (const inp of analysis.inputs) {
      const hint = inp.sensitive ? REDACTED : safeTerminalText(inp.hint);
      const value = inp.sensitive
        ? ` = "${REDACTED}"`
        : inp.value
          ? ` = "${safeTerminalText(inp.value)}"`
          : " (empty)";
      lines.push(`  [${inp.index}] ${hint || "text field"}${value} @ (${inp.coordinates.x}, ${inp.coordinates.y})`);
    }
    lines.push("");
  }

  if (analysis.texts.length > 0) {
    lines.push(`Text on screen:`);
    for (const txt of analysis.texts.slice(0, 10)) {
      const content = safeTerminalText(txt.content);
      lines.push(`  "${content.slice(0, 60)}${content.length > 60 ? "..." : ""}"`);
    }
    if (analysis.texts.length > 10) {
      lines.push(`  ... and ${analysis.texts.length - 10} more`);
    }
  }

  return lines.join("\n");
}
