import type { ScreenAnalysis, UiElement } from "../types.js";
import { formatUiTreeCompact } from "./compact.js";

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
