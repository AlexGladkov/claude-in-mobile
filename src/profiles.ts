/**
 * Mobile profiles — profile-based tool visibility.
 *
 * MOBILE_PROFILE env var determines the startup set of visible tools.
 * LLM can enable additional modules at runtime via device(action:'enable_module').
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MobileProfile = "minimal" | "core" | "android" | "web" | "full";

export type ModuleCategory = "core" | "platform" | "testing" | "automation";

export interface ModuleMeta {
  /** Tool name (matches meta-tool name in registry) */
  name: string;
  /** Human-readable description for list_modules */
  description: string;
  /** Grouping category */
  category: ModuleCategory;
  /** Actions exposed by this meta-tool */
  actions: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** These tools are ALWAYS visible regardless of profile. Invariant. */
export const ALWAYS_VISIBLE: readonly string[] = ["device", "screen"];

/** All module names that can be hidden/shown (everything except ALWAYS_VISIBLE) */
export const ALL_HIDEABLE_MODULES: readonly string[] = [
  "input", "ui", "app", "system", "flow",
  "browser", "desktop", "store",
  "visual", "recorder", "sync",
  "accessibility", "performance", "autopilot",
];

// ---------------------------------------------------------------------------
// Profile presets — which modules are VISIBLE at startup (besides ALWAYS_VISIBLE)
// ---------------------------------------------------------------------------

export const PROFILE_VISIBLE: Record<MobileProfile, readonly string[]> = {
  minimal: [],
  core: ["input", "ui", "app", "system", "flow"],
  android: ["input", "ui", "app", "system", "flow"],
  web: ["input", "ui", "app", "system", "flow", "browser"],
  full: [...ALL_HIDEABLE_MODULES],
};

/** All valid profile names */
export const VALID_PROFILES: readonly MobileProfile[] = ["minimal", "core", "android", "web", "full"];

// ---------------------------------------------------------------------------
// Module metadata catalog — all 16 modules (including always-visible)
// ---------------------------------------------------------------------------

export const MODULE_METADATA: readonly ModuleMeta[] = [
  // Always visible
  { name: "device", description: "Device management, module loading, target switching", category: "core", actions: ["list", "set", "set_target", "get_target", "enable_module", "disable_module", "list_modules"] },
  { name: "screen", description: "Screenshot capture, annotation, diff comparison", category: "core", actions: ["capture", "annotate"] },

  // Core modules
  { name: "input", description: "Tap, swipe, type, key press — all input actions", category: "core", actions: ["tap", "double_tap", "long_press", "swipe", "text", "key"] },
  { name: "ui", description: "Accessibility tree, element search, assertions, waits", category: "core", actions: ["tree", "find", "find_tap", "tap_text", "analyze", "wait", "assert_visible", "assert_gone"] },
  { name: "app", description: "Launch, stop, install, list applications", category: "core", actions: ["launch", "stop", "install", "list"] },
  { name: "system", description: "Shell, logs, clipboard, permissions, URL, device info", category: "core", actions: ["activity", "shell", "wait", "open_url", "logs", "clear_logs", "info", "webview", "clipboard_select", "clipboard_copy", "clipboard_paste", "clipboard_get", "permission_grant", "permission_revoke", "permission_reset", "file_push", "file_pull", "metrics", "reset_metrics"] },
  { name: "flow", description: "Batch commands, multi-step automation, parallel execution", category: "automation", actions: ["batch", "run", "parallel"] },

  // Platform modules
  { name: "browser", description: "Browser automation — navigate, evaluate JS, manage tabs", category: "platform", actions: ["navigate", "evaluate", "console", "network", "tabs", "cookies", "screenshot"] },
  { name: "desktop", description: "Desktop app control — windows, clipboard, performance", category: "platform", actions: ["launch", "stop", "windows", "focus", "resize", "clipboard_get", "clipboard_set", "performance", "monitors"] },
  { name: "store", description: "App store metadata — ratings, reviews, versions", category: "platform", actions: ["search", "details", "reviews", "similar"] },

  // Testing modules
  { name: "visual", description: "Visual regression testing — compare screenshots", category: "testing", actions: ["compare", "baseline", "diff", "report"] },
  { name: "accessibility", description: "Accessibility audit — WCAG checks, element validation", category: "testing", actions: ["audit", "check", "summary", "rules"] },
  { name: "performance", description: "Performance monitoring — snapshots, baselines, crashes", category: "testing", actions: ["snapshot", "baseline", "compare", "monitor", "crashes"] },

  // Automation modules
  { name: "recorder", description: "Record and replay interaction sequences", category: "automation", actions: ["start", "stop", "play", "list", "delete"] },
  { name: "sync", description: "Multi-device synchronization and coordination", category: "automation", actions: ["pair", "unpair", "broadcast", "status"] },
  { name: "autopilot", description: "AI-driven test generation and self-healing", category: "automation", actions: ["explore", "generate", "heal", "status", "tests"] },
];

/** Quick lookup: module name -> metadata */
export const MODULE_METADATA_MAP: ReadonlyMap<string, ModuleMeta> = new Map(
  MODULE_METADATA.map(m => [m.name, m]),
);

/** Get modules by category */
export function getModulesByCategory(category: ModuleCategory): ModuleMeta[] {
  return MODULE_METADATA.filter(m => m.category === category);
}

/** Get hideable module names by category */
export function getHideableNamesByCategory(category: ModuleCategory): string[] {
  return MODULE_METADATA
    .filter(m => m.category === category && !ALWAYS_VISIBLE.includes(m.name))
    .map(m => m.name);
}
