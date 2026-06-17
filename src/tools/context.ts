/**
 * ToolContext facade — re-exports from submodules for backwards compatibility.
 *
 * All existing `import { ... } from "./context.js"` continue to work unchanged.
 * Internal logic is split into:
 *   - context/shared-state.ts  — per-platform caches
 *   - context/ios-helpers.ts   — iOS tree parsing
 *   - context/hints.ts         — action hints & platform element helpers
 */

import { DeviceManager, createFullDeviceManager, Platform } from "../device-manager.js";
import type { UiElement } from "../ui-tree/ui-parser.js";

// Re-export submodule symbols so every existing import path keeps working
export {
  getCachedElements,
  setCachedElements,
  lastScreenshotMap,
  lastUiTreeMap,
  screenshotScaleMap,
  invalidateUiTreeCache,
} from "./context/shared-state.js";

export {
  iosTreeToUiElements,
  formatIOSUITree,
} from "./context/ios-helpers.js";

// Hints are factory-based (capture deviceManager), but we re-export the
// standalone versions bound to the shared deviceManager singleton below.
import { createGenerateActionHints, createGetElementsForPlatform } from "./context/hints.js";
import {
  getCachedElements,
  setCachedElements,
  lastScreenshotMap,
  lastUiTreeMap,
  screenshotScaleMap,
  invalidateUiTreeCache,
} from "./context/shared-state.js";
import { iosTreeToUiElements, formatIOSUITree } from "./context/ios-helpers.js";

// Shared device manager singleton
export const deviceManager = createFullDeviceManager();

// Bound hint functions for the shared deviceManager (non-turbo defaults for backward compat)
export const generateActionHints = createGenerateActionHints(deviceManager);
export const getElementsForPlatform = createGetElementsForPlatform(deviceManager);

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
  lastUiTreeMap: Map<string, { text: string; timestamp: number }>;
  screenshotScaleMap: Map<string, { scaleX: number; scaleY: number }>;
  generateActionHints: (platform?: string) => Promise<string>;
  getElementsForPlatform: (plat: string) => Promise<UiElement[]>;
  iosTreeToUiElements: (tree: any) => UiElement[];
  formatIOSUITree: (tree: any, indent?: number) => string;
  invalidateUiTreeCache: (platform?: string) => void;
  platformParam: typeof platformParam;
  handleTool: (name: string, args: Record<string, unknown>, depth?: number) => Promise<unknown>;
  turboDefault: boolean;
}

export function createToolContext(
  handleTool: ToolContext["handleTool"],
  options?: { turboDefault?: boolean },
): ToolContext {
  const turbo = options?.turboDefault ?? false;

  // When turbo is enabled, create dedicated hint functions that pass turbo=true
  // down to DeviceManager and use adaptive delays. When off, use the default
  // non-turbo singletons for zero-overhead backward compatibility.
  const turboHints = turbo
    ? createGenerateActionHints(deviceManager, { turbo: true })
    : generateActionHints;
  const turboElements = turbo
    ? createGetElementsForPlatform(deviceManager, { turbo: true })
    : getElementsForPlatform;

  return {
    deviceManager,
    getCachedElements,
    setCachedElements,
    lastScreenshotMap,
    lastUiTreeMap,
    screenshotScaleMap,
    generateActionHints: turboHints,
    getElementsForPlatform: turboElements,
    iosTreeToUiElements,
    formatIOSUITree,
    invalidateUiTreeCache,
    platformParam,
    handleTool,
    turboDefault: turbo,
  };
}
