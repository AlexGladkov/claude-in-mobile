import { DeviceManager, Platform } from "../device-manager.js";
import {
  parseUiHierarchy,
  desktopHierarchyToUiElements,
  diffUiElements,
  suggestNextActions,
  findElements,
  UiElement,
} from "../adb/ui-parser.js";

// Shared device manager singleton
export const deviceManager = new DeviceManager();

// Per-platform cache for UI elements (to support tap by index)
const cachedElementsMap: Map<string, UiElement[]> = new Map();

// Per-platform cache for last screenshot buffer (for diff mode)
export const lastScreenshotMap: Map<string, Buffer> = new Map();

// Per-platform screenshot scale factors (compressed image → device coordinates)
export const screenshotScaleMap: Map<string, { scaleX: number; scaleY: number }> = new Map();

export function getCachedElements(platform: string): UiElement[] {
  return cachedElementsMap.get(platform) ?? [];
}

export function setCachedElements(platform: string, elements: UiElement[]): void {
  cachedElementsMap.set(platform, elements);
}

/**
 * Convert iOS accessibility tree (from WDA) to UiElement[] for annotation
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

/**
 * Generate action hints by diffing before/after UI state.
 */
export async function generateActionHints(platform: string | undefined): Promise<string> {
  const currentPlatform = platform ?? deviceManager.getCurrentPlatform() ?? "android";
  const beforeElements = getCachedElements(currentPlatform);

  await new Promise(resolve => setTimeout(resolve, 150));

  let afterElements: UiElement[] = [];
  try {
    if (currentPlatform === "android") {
      const xml = await deviceManager.getUiHierarchyAsync("android");
      afterElements = parseUiHierarchy(xml);
    } else if (currentPlatform === "ios") {
      const json = await deviceManager.getUiHierarchy("ios");
      const tree = JSON.parse(json);
      afterElements = iosTreeToUiElements(tree);
    } else if (currentPlatform === "desktop") {
      const text = await deviceManager.getUiHierarchyAsync("desktop");
      afterElements = desktopHierarchyToUiElements(text);
    }
  } catch (hintError: any) {
    const reason = hintError?.message ?? "unknown error";
    return `\n--- Hints ---\nUnable to fetch UI state for hints: ${reason}`;
  }

  setCachedElements(currentPlatform, afterElements);

  if (beforeElements.length === 0 && afterElements.length === 0) {
    return "\n--- Hints ---\nNo UI elements detected.";
  }

  const diff = diffUiElements(beforeElements, afterElements);
  const suggestions = suggestNextActions(afterElements);

  const lines: string[] = ["\n--- Hints ---"];

  if (diff.screenChanged) {
    lines.push("Screen changed (new activity or major UI update)");
  }
  if (diff.appeared.length > 0) {
    lines.push(`New: ${diff.appeared.join(", ")}`);
  }
  if (diff.disappeared.length > 0) {
    lines.push(`Gone: ${diff.disappeared.join(", ")}`);
  }
  lines.push(`Elements: ${diff.beforeCount} → ${diff.afterCount}`);
  if (suggestions.length > 0) {
    lines.push(`Suggested: ${suggestions.join("; ")}`);
  }

  return lines.join("\n");
}

/**
 * Get UI elements for the current platform (helper for flow element checks)
 */
export async function getElementsForPlatform(plat: string): Promise<UiElement[]> {
  if (plat === "android" || !plat) {
    const xml = await deviceManager.getUiHierarchyAsync("android");
    const elements = parseUiHierarchy(xml);
    setCachedElements("android", elements);
    return elements;
  } else if (plat === "ios") {
    const json = await deviceManager.getUiHierarchy("ios");
    const tree = JSON.parse(json);
    const elements = iosTreeToUiElements(tree);
    setCachedElements("ios", elements);
    return elements;
  } else if (plat === "desktop") {
    const text = await deviceManager.getUiHierarchyAsync("desktop");
    const elements = desktopHierarchyToUiElements(text);
    setCachedElements("desktop", elements);
    return elements;
  }
  return [];
}

// Platform parameter schema (reused across tools)
export const platformParam = {
  type: "string",
  enum: ["android", "ios", "desktop", "aurora", "browser"],
  description: "Target platform. If not specified, uses the active target.",
};

// Maximum recursion depth for batch_commands / run_flow
export const MAX_RECURSION_DEPTH = 3;

export interface ToolContext {
  deviceManager: DeviceManager;
  getCachedElements: (platform: string) => UiElement[];
  setCachedElements: (platform: string, elements: UiElement[]) => void;
  lastScreenshotMap: Map<string, Buffer>;
  screenshotScaleMap: Map<string, { scaleX: number; scaleY: number }>;
  generateActionHints: (platform?: string) => Promise<string>;
  getElementsForPlatform: (plat: string) => Promise<UiElement[]>;
  iosTreeToUiElements: (tree: any) => UiElement[];
  formatIOSUITree: (tree: any, indent?: number) => string;
  platformParam: typeof platformParam;
  handleTool: (name: string, args: Record<string, unknown>, depth?: number) => Promise<unknown>;
}

export function createToolContext(handleTool: ToolContext["handleTool"]): ToolContext {
  return {
    deviceManager,
    getCachedElements,
    setCachedElements,
    lastScreenshotMap,
    screenshotScaleMap,
    generateActionHints,
    getElementsForPlatform,
    iosTreeToUiElements,
    formatIOSUITree,
    platformParam,
    handleTool,
  };
}
