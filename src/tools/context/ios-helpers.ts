/**
 * iOS-specific tree parsing: convert WDA accessibility tree to UiElement[].
 */

import type { UiElement } from "../../adb/ui-parser.js";

/**
 * Convert iOS accessibility tree (from WDA) to UiElement[] for annotation.
 */
export function iosTreeToUiElements(tree: any, elements: UiElement[] = [], index = { value: 0 }): UiElement[] {
  if (tree.rect) {
    const x = tree.rect.x ?? 0;
    const y = tree.rect.y ?? 0;
    const w = tree.rect.width ?? 0;
    const h = tree.rect.height ?? 0;

    if (w > 0 && h > 0) {
      elements.push({
        index: index.value++,
        resourceId: tree.identifier ?? "",
        className: tree.type ?? "",
        packageName: "",
        text: tree.label ?? tree.value ?? "",
        contentDesc: tree.name ?? "",
        checkable: false,
        checked: false,
        clickable: tree.enabled !== false && (tree.type?.includes("Button") || tree.type?.includes("Link") || tree.type?.includes("Cell")),
        enabled: tree.enabled !== false,
        focusable: tree.enabled !== false,
        focused: false,
        scrollable: tree.type?.includes("ScrollView") ?? false,
        longClickable: false,
        password: tree.type?.includes("SecureTextField") ?? false,
        selected: tree.selected ?? false,
        bounds: { x1: x, y1: y, x2: x + w, y2: y + h },
        centerX: Math.floor(x + w / 2),
        centerY: Math.floor(y + h / 2),
        width: w,
        height: h,
      });
    }
  }

  if (tree.children) {
    for (const child of tree.children) {
      iosTreeToUiElements(child, elements, index);
    }
  }

  return elements;
}

export function formatIOSUITree(tree: any, indent = 0): string {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  if (tree.type) {
    const parts: string[] = [`<${tree.type}>`];
    if (tree.label) parts.push(`label="${tree.label}"`);
    if (tree.value) parts.push(`value="${tree.value}"`);
    if (tree.name) parts.push(`name="${tree.name}"`);
    if (tree.identifier) parts.push(`id="${tree.identifier}"`);
    if (tree.enabled !== undefined) parts.push(`enabled=${tree.enabled}`);
    if (tree.rect) parts.push(`@ (${tree.rect.x}, ${tree.rect.y})`);
    lines.push(`${prefix}${parts.join(' ')}`);
  }

  if (tree.children) {
    for (const child of tree.children) {
      lines.push(formatIOSUITree(child, indent + 1));
    }
  }

  return lines.join('\n');
}
