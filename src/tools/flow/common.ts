import { getRegisteredToolNames } from "../registry.js";
import type { ToolContext } from "../context.js";
import { parseUiHierarchy, UiElement } from "../../ui-tree/ui-parser.js";
import { applyScale } from "../helpers/resolve-element.js";
import { z } from "../define-tool.js";
import { FLOW } from "../../constants/timeouts.js";

// Actions explicitly blocked from flow execution (security-sensitive).
// Everything else registered in the registry is allowed.
export const FLOW_BLOCKED_ACTIONS: Readonly<Record<string, true>> = {
  system_shell: true,
  browser_evaluate: true,
};

/**
 * Check whether an action is allowed in flow_batch / flow_run / flow_parallel.
 *
 * Strategy: blocklist instead of allowlist. Any registered tool or alias is
 * allowed unless it is in FLOW_BLOCKED_ACTIONS. This eliminates the need
 * to maintain a 50+ entry hardcoded allowlist that goes stale with every
 * new tool or alias.
 */
export function isFlowActionAllowed(actionName: string): boolean {
  if (Object.hasOwn(FLOW_BLOCKED_ACTIONS, actionName)) return false;
  return getRegisteredToolNames().has(actionName);
}

export const FLOW_MAX_STEPS = FLOW.MAX_STEPS;
export const BATCH_MAX_COMMANDS = 50;
export const FLOW_MAX_DURATION = FLOW.MAX_DURATION_MS;
export const FLOW_MAX_REPEAT = 10;
export const PARALLEL_MAX_DEVICES = 10;

export interface FlowStep {
  action: string;
  args?: Record<string, unknown>;
  if_not_found?: "skip" | "scroll_down" | "scroll_up" | "fail";
  repeat?: { times?: number; until_found?: string; until_not_found?: string };
  on_error?: "stop" | "skip" | "retry";
  label?: string;
}

export interface FlowStepResult {
  step: number;
  action: string;
  label?: string;
  success: boolean;
  message: string;
  durationMs: number;
}

/** ContentBlock for turbo multi-content responses */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Collect compact UI tree: interactive elements, no passwords, redacted input text.
 * Returns pipe-separated one-liner like: Button "Login" | EditText [input] | TextView "Welcome"
 */
export async function collectCompactUiTree(
  ctx: ToolContext,
  platform: string,
): Promise<string> {
  const elements = await Promise.race([
    ctx.getElementsForPlatform(platform),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ui tree timeout")), FLOW.UI_TREE_TIMEOUT_MS)),
  ]);
  const interactive = elements.filter(
    (el: UiElement) => !el.password && (el.clickable || el.scrollable || el.className.includes("EditText")),
  );
  const limited = interactive.slice(0, 15);
  if (limited.length === 0) return "";
  const parts = limited.map((el: UiElement) => {
    const shortClass = el.className.split(".").pop() ?? "";
    const isEditText = el.className.includes("EditText");
    const label = isEditText ? "[input]" : (el.contentDesc || el.text || "");
    return `${shortClass}${label ? ` "${label}"` : ""}`;
  });
  return parts.join(" | ");
}

// ─── Turbo fast-track: combine action + UI dump in 1 ADB call ───
// Saves ~150-300ms per step by eliminating extra process spawn.
// Only for Android, simple actions (tap/key/text), no element resolution.

const FAST_TRACK_KEYS: Record<string, number> = {
  BACK: 4, HOME: 3, MENU: 82, ENTER: 66, TAB: 61,
  DELETE: 67, BACKSPACE: 67, POWER: 26, VOLUME_UP: 24, VOLUME_DOWN: 25,
  ESCAPE: 111, SPACE: 62, DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21,
  DPAD_RIGHT: 22, DPAD_CENTER: 23, APP_SWITCH: 187, WAKEUP: 224,
};

/** Actions eligible for fast-track (canonical + common aliases). */
const FAST_TRACK_ACTION_KIND: Readonly<Record<string, "tap" | "key" | "text">> = {
  input_tap: "tap",
  tap: "tap",
  click: "tap",
  input_key: "key",
  press_key: "key",
  press_button: "key",
  input_text: "text",
  type_text: "text",
  type: "text",
};

/** Convert spaces to the encoding expected by Android's `input text`. */
function encodeAdbText(text: string): string {
  return text.replace(/[\n\r]/g, "").replace(/ /g, "%s");
}

export interface FastTrackResult {
  message: string;
  uiCompact: string;
}

/**
 * Try to execute a step via fast-track (1 ADB call for action + UI dump).
 * Returns null if the step can't be fast-tracked → caller falls through to handleTool.
 */
export async function turboFastTrack(
  step: FlowStep,
  ctx: ToolContext,
  platform: string,
  deviceId?: string,
): Promise<FastTrackResult | null> {
  if (platform !== "android") return null;

  const action = step.action;
  const actionKind = FAST_TRACK_ACTION_KIND[action];
  const args = step.args ?? {};
  let actionArgs: string[] | null = null;
  let message = "";

  // input_tap — only raw x/y (no element resolution)
  if (actionKind === "tap"
      && typeof args.x === "number" && typeof args.y === "number"
      && !args.text && !args.resourceId && !args.index && !args.label) {
    const scaled = await applyScale(args.x, args.y, platform, ctx, deviceId);
    actionArgs = ["input", "tap", String(scaled.x), String(scaled.y)];
    message = `Tapped at (${scaled.x}, ${scaled.y})`;
  }

  // input_key
  else if (actionKind === "key" && args.key) {
    const key = String(args.key).toUpperCase();
    const mapped = FAST_TRACK_KEYS[key];
    const code = mapped ?? Number(key);
    if (!Number.isSafeInteger(code) || code < 0) return null;
    actionArgs = ["input", "keyevent", String(code)];
    message = `Pressed key: ${key}`;
  }

  // input_text
  else if (actionKind === "text" && args.text) {
    const text = String(args.text);
    actionArgs = ["input", "text", encodeAdbText(text)];
    message = `Entered ${text.length} character(s)`;
  }

  if (!actionArgs) return null;

  try {
    const adb = ctx.deviceManager.getAndroidClient(deviceId);
    const { uiXml } = await adb.execWithUiDump(actionArgs);

    let uiCompact = "";
    if (uiXml) {
      const elements = parseUiHierarchy(uiXml);
      ctx.setCachedElements(platform, elements);
      // Build compact tree inline (same logic as collectCompactUiTree but no extra call)
      const interactive = elements.filter(
        (el) => !el.password && (el.clickable || el.scrollable || el.className.includes("EditText")),
      );
      const limited = interactive.slice(0, 15);
      uiCompact = limited.map((el) => {
        const shortClass = el.className.split(".").pop() ?? "";
        const isEditText = el.className.includes("EditText");
        const label = isEditText ? "[input]" : (el.contentDesc || el.text || "");
        return `${shortClass}${label ? ` "${label}"` : ""}`;
      }).join(" | ");
    }

    return { message, uiCompact };
  } catch {
    return null; // Fast-track failed, fall through to normal path
  }
}

/** Collect brief UI context for diagnostics on flow step failure */
export async function collectFailureDiag(
  ctx: ToolContext,
  platform: string,
  stepIndex: number,
): Promise<string> {
  try {
    const tree = await collectCompactUiTree(ctx, platform);
    if (!tree) return "";
    return `\n[DIAG:step${stepIndex}] Available UI:\n  ${tree}`;
  } catch {
    return ""; // silently skip diagnostics
  }
}

/** Capture a compressed screenshot for turbo mode. Returns base64 data or null on failure. */
export async function captureTurboScreenshot(
  ctx: ToolContext,
  platform: string,
): Promise<{ data: string; mimeType: string } | null> {
  try {
    const result = await ctx.handleTool("screen_capture", { platform, preset: "low", compress: true });
    if (typeof result === "object" && result !== null && "image" in result) {
      const img = (result as { image: { data: string; mimeType: string } }).image;
      return { data: img.data, mimeType: img.mimeType };
    }
    return null;
  } catch {
    return null;
  }
}

export interface TurboStepContext {
  uiTree?: string;
  hasScreenshot?: boolean;
}

export function formatFlowResults(
  results: FlowStepResult[],
  totalMs: number,
  diagBlock: string = "",
  turboContexts?: Map<number, TurboStepContext>,
): string {
  const lines: string[] = [`Flow completed (${totalMs}ms)`, ""];
  for (const r of results) {
    const label = r.label ? ` (${r.label})` : "";
    const status = r.success ? "OK" : "FAIL";
    lines.push(`${r.step}. ${r.action}${label}: ${status} — ${r.message} (${r.durationMs}ms)`);
    const turbo = turboContexts?.get(r.step);
    if (turbo?.uiTree) {
      lines.push(`   [UI] ${turbo.uiTree}`);
    }
    if (turbo?.hasScreenshot) {
      lines.push(`   [screenshot attached]`);
    }
  }
  return lines.join("\n") + diagBlock;
}

// Zod schemas
export const platformEnum = z
  .enum(["android", "ios", "desktop", "aurora", "harmony", "browser"])
  .optional()
  .describe("Target platform. If not specified, uses the active target.");

export const batchCommandSchema = z.object({
  name: z.string().describe("Tool name (e.g., 'input_tap', 'system_wait', 'input_text')"),
  arguments: z.record(z.string(), z.unknown()).optional().describe("Tool arguments"),
});

export const flowStepSchema = z.object({
  action: z.string().describe("Any registered tool name except system_shell and browser_evaluate"),
  args: z.record(z.string(), z.unknown()).optional().describe("Tool arguments"),
  if_not_found: z
    .enum(["skip", "scroll_down", "scroll_up", "fail"])
    .optional()
    .describe("Fallback when element not found (for tap/find actions)"),
  repeat: z
    .object({
      times: z.number().optional().describe("Repeat N times (max 10)"),
      until_found: z.string().optional().describe("Repeat until element with this text appears"),
      until_not_found: z.string().optional().describe("Repeat until element with this text disappears"),
    })
    .optional()
    .describe("Loop control"),
  on_error: z.enum(["stop", "skip", "retry"]).optional().describe("Error handling (default: stop)"),
  label: z.string().optional().describe("Label for logging"),
});
