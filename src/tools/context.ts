/**
 * ToolContext facade — re-exports from submodules for backwards compatibility.
 *
 * All existing `import { ... } from "./context.js"` continue to work unchanged.
 * Internal logic is split into:
 *   - context/shared-state.ts  — per-platform caches
 *   - context/ios-helpers.ts   — iOS tree parsing
 *   - context/hints.ts         — action hints & platform element helpers
 */

import { DeviceManager } from "../device-manager.js";
import type { Platform } from "../device-manager.js";
import type { CorePlatformAdapter } from "../adapters/platform-adapter.js";
import type { UiElement } from "../ui-tree/ui-parser.js";
import type { ScreenshotScale } from "./context/shared-state-class.js";

// Re-export submodule symbols so every existing import path keeps working
export {
  getCachedElements,
  isCachedElementsStale,
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
  isCachedElementsStale,
  setCachedElements,
  lastScreenshotMap,
  lastUiTreeMap,
  screenshotScaleMap,
  invalidateUiTreeCache,
} from "./context/shared-state.js";
import { iosTreeToUiElements, formatIOSUITree } from "./context/ios-helpers.js";
import { PLATFORM_JSON_SCHEMA } from "./common-schema.js";

// Production tools receive a kernel-backed manager. Standalone consumers and
// tests use this explicit empty manager until they provide an adapter.
export const deviceManager = new DeviceManager({
  adapters: new Map<Platform, CorePlatformAdapter>(),
});

// Bound hint functions for the shared deviceManager (non-turbo defaults for backward compat)
export const generateActionHints = createGenerateActionHints(deviceManager);
export const getElementsForPlatform = createGetElementsForPlatform(deviceManager);

export const platformParam = {
  ...PLATFORM_JSON_SCHEMA,
  description: "Target platform. If not specified, uses the active target.",
};

// Maximum recursion depth for batch_commands / run_flow
export const MAX_RECURSION_DEPTH = 3;

export interface ToolContext {
  deviceManager: DeviceManager;
  getCachedElements: (platform: string, deviceId?: string) => UiElement[];
  isCachedElementsStale?: (platform: string, deviceId?: string) => boolean;
  setCachedElements: (platform: string, elements: UiElement[], deviceId?: string) => void;
  lastScreenshotMap: Map<string, Buffer>;
  lastUiTreeMap: Map<string, { text: string; timestamp: number }>;
  screenshotScaleMap: Map<string, ScreenshotScale>;
  generateActionHints: (platform?: string, deviceId?: string) => Promise<string>;
  getElementsForPlatform: (plat: string, deviceId?: string) => Promise<UiElement[]>;
  iosTreeToUiElements: (tree: unknown) => UiElement[];
  formatIOSUITree: (tree: unknown, indent?: number) => string;
  invalidateUiTreeCache: (platform?: string, deviceId?: string) => void;
  platformParam: typeof platformParam;
  handleTool: (name: string, args: Record<string, unknown>, depth?: number, signal?: AbortSignal) => Promise<unknown>;
  /** Signal for the current request, when a parent flow supplies one. */
  signal?: AbortSignal;
  turboDefault: boolean;
}

export function createToolContext(
  handleTool: ToolContext["handleTool"],
  options?: { turboDefault?: boolean; deviceManager?: DeviceManager },
): ToolContext {
  const turbo = options?.turboDefault ?? false;
  // The server injects the kernel-backed DeviceManager (built from the enabled
  // platform plugins). Falls back to the module singleton only for tests /
  // callers that don't pass one. Without this injection the tools would route
  // through the legacy empty adapter map and every platform call would fail.
  const dm = options?.deviceManager ?? deviceManager;

  // Hints must bind to the SAME deviceManager the tools use, else hint
  // generation and tool execution disagree on which adapters exist.
  const turboHints = turbo
    ? createGenerateActionHints(dm, { turbo: true })
    : createGenerateActionHints(dm);
  const turboElements = turbo
    ? createGetElementsForPlatform(dm, { turbo: true })
    : createGetElementsForPlatform(dm);

  return {
    deviceManager: dm,
    getCachedElements,
    isCachedElementsStale,
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
