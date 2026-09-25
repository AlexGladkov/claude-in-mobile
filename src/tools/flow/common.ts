import { getRegisteredToolNames, resolveToolIdentity } from "../registry.js";
import type { ResolvedToolIdentity } from "../registry.js";
import { parseUiHierarchy, UiElement } from "../../ui-tree/ui-parser.js";
import { isSecureElement } from "../../ui-tree/ui-parser/formatters/redact.js";
import { applyScale } from "../helpers/resolve-element.js";
import { z } from "../define-tool.js";
export { platformEnum } from "../common-schema.js";
import type { ToolContext } from "../context.js";
import { FLOW } from "../../constants/timeouts.js";

// Explicitly exclude shell-like and debugger code-execution/mutation tools.
// Flow can still orchestrate the remaining registered actions.
export const FLOW_BLOCKED_ACTIONS: Readonly<Record<string, true>> = {
  system_shell: true,
  browser_evaluate: true,
  debug_eval: true,
  debug_set_var: true,
  // Installing/uninstalling packages and pushing files are persistent device mutations.
  app_install: true,
  app_uninstall: true,
  system_file_push: true,
  install_app: true,
  uninstall_app: true,
  push_file: true,
};

function isCanonicalBlocked(resolved: ResolvedToolIdentity): boolean {
  if (Object.hasOwn(FLOW_BLOCKED_ACTIONS, resolved.canonical)) return true;

  // Meta-tools dispatch by action (for example system + action:"shell").
  // Derive the canonical leaf ID instead of adding every alias to a denylist.
  const action = resolved.args.action;
  return typeof action === "string"
    && Object.hasOwn(FLOW_BLOCKED_ACTIONS, `${resolved.canonical}_${action}`);
}

/**
 * Check whether an action is allowed in flow_batch / flow_run / flow_parallel.
 *
 * Strategy: blocklist instead of allowlist. Resolve aliases to their concrete
 * tool identity first, then apply the blocklist to that canonical identity.
 * Any other registered tool or alias remains allowed.
 */
export function isFlowActionAllowed(
  actionName: string,
  actionArgs: Record<string, unknown> = {},
): boolean {
  if (Object.hasOwn(FLOW_BLOCKED_ACTIONS, actionName)) return false;
  if (!getRegisteredToolNames().has(actionName)) return false;

  const resolved = resolveToolIdentity(actionName, actionArgs);
  return resolved ? !isCanonicalBlocked(resolved) : false;
}


export const FLOW_MAX_STEPS = FLOW.MAX_STEPS;
export const BATCH_MAX_COMMANDS = 50;
export const FLOW_MAX_DURATION = FLOW.MAX_DURATION_MS;
export const FLOW_MAX_REPEAT = 10;
export const PARALLEL_MAX_DEVICES = 10;
export class FlowTimeoutError extends Error {
  constructor(message = "Flow action timed out") {
    super(message);
    this.name = "FlowTimeoutError";
  }
}

class FlowCancelledError extends Error {
  constructor() {
    super("Flow cancelled");
    this.name = "FlowCancelledError";
  }
}

export function linkFlowAbortController(
  parentSignal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!parentSignal) return () => {};
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return () => {};
  }

  let disposed = false;
  let abortFromParent: () => void = () => {};
  const unlink = (): void => {
    if (disposed) return;
    disposed = true;
    parentSignal.removeEventListener("abort", abortFromParent);
    controller.signal.removeEventListener("abort", unlink);
  };
  abortFromParent = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal.reason);
  };

  parentSignal.addEventListener("abort", abortFromParent, { once: true });
  controller.signal.addEventListener("abort", unlink, { once: true });
  if (parentSignal.aborted || controller.signal.aborted) {
    abortFromParent();
    unlink();
  }
  return unlink;
}


/**
 * Race a nested flow operation against the remaining flow deadline.
 * A timed-out operation is deliberately not awaited after the race: callers
 * must stop the flow, while the optional signal gives cooperative handlers a
 * chance to cancel their underlying work.
 */
export async function runWithDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new FlowCancelledError();
  if (timeoutMs <= 0) {
    onTimeout?.();
    throw new FlowTimeoutError();
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new FlowTimeoutError());
      onTimeout?.();
    }, timeoutMs);
  });
  const operationPromise = Promise.resolve().then(() => {
    if (signal?.aborted) throw new FlowCancelledError();
    return operation();
  });
  // A deadline/cancellation race can detach an operation that later rejects.
  void operationPromise.catch(() => {});

  const cancellationPromise = signal
    ? new Promise<never>((_, reject) => {
      abortHandler = () => reject(new FlowCancelledError());
      signal.addEventListener("abort", abortHandler, { once: true });
      if (signal.aborted) abortHandler();
    })
    : undefined;

  try {
    return await Promise.race(
      cancellationPromise
        ? [operationPromise, timeoutPromise, cancellationPromise]
        : [operationPromise, timeoutPromise],
    );
  } finally {
    clearTimeout(timeoutHandle);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
  }
}

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
  deviceId?: string,
  signal?: AbortSignal,
): Promise<string> {
  const elements = await runWithDeadline(
    () => ctx.getElementsForPlatform(platform, deviceId),
    FLOW.UI_TREE_TIMEOUT_MS,
    undefined,
    signal,
  );
  const interactive = elements.filter(
    (el: UiElement) => !isSecureElement(el) && (el.clickable || el.scrollable || el.className.includes("EditText")),
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
  timeoutMs?: number,
  onTimeout?: () => void,
  signal?: AbortSignal,
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

  let actionRequest: Promise<{ uiXml: string }> | undefined;
  let uiXml: string;
  try {
    const adb = ctx.deviceManager.getAndroidClient(deviceId);
    const request = adb.execWithUiDump(actionArgs, undefined, signal);
    actionRequest = request;
    ({ uiXml } = await runWithDeadline(
      () => request,
      timeoutMs ?? FLOW.UI_TREE_TIMEOUT_MS,
      onTimeout,
      signal,
    ));
  } catch (error) {
    // The flow deadline aborts the ADB child. Wait for it to close before
    // returning so no timed-out action remains active after the flow result.
    if (signal?.aborted && actionRequest) await actionRequest.catch(() => {});
    throw error;
  }

  let uiCompact = "";
  if (uiXml) {
    const elements = parseUiHierarchy(uiXml);
    ctx.setCachedElements(platform, elements, deviceId);
    // Build compact tree inline (same logic as collectCompactUiTree but no extra call)
    const interactive = elements.filter(
      (el) => !isSecureElement(el) && (el.clickable || el.scrollable || el.className.includes("EditText")),
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
}

/** Collect brief UI context for diagnostics on flow step failure */
export async function collectFailureDiag(
  ctx: ToolContext,
  platform: string,
  stepIndex: number,
  deviceId?: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const tree = await collectCompactUiTree(ctx, platform, deviceId, signal);
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
  deviceId?: string,
  signal?: AbortSignal,
  timeoutMs: number = FLOW.UI_TREE_TIMEOUT_MS,
  parentDepth: number = 0,
): Promise<{ data: string; mimeType: string } | null> {
  try {
    const screenArgs: Record<string, unknown> = { platform, preset: "low", compress: true };
    if (deviceId !== undefined) screenArgs.deviceId = deviceId;
    const nestedDepth = parentDepth + 1;
    const invokeCapture = signal
      ? () => ctx.handleTool("screen_capture", screenArgs, nestedDepth, signal)
      : () => ctx.handleTool("screen_capture", screenArgs, nestedDepth);
    const result = await runWithDeadline(invokeCapture, timeoutMs, undefined, signal);
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
  incomplete = false,
): string {
  const lines: string[] = [`Flow ${incomplete ? "incomplete" : "completed"} (${totalMs}ms)`, ""];
  for (const r of results) {
    const label = r.label ? ` (${r.label})` : "";
    const status = r.success ? "OK" : "FAIL";
    let message: string;
    switch (r.message) {
      case "Skipped (element not found)":
        message = "Skipped (element not found)";
        break;
      case "OK (after scroll_down)":
        message = "OK (after scroll_down)";
        break;
      case "OK (after scroll_up)":
        message = "OK (after scroll_up)";
        break;
      case "Action failed (after scroll_down)":
        message = "Action failed (after scroll_down)";
        break;
      case "Action failed (after scroll_up)":
        message = "Action failed (after scroll_up)";
        break;
      case "Flow timeout":
        message = "Flow timeout";
        break;
      case "Flow cancelled":
        message = "Flow cancelled";
        break;
      default:
        message = r.success ? "OK" : "Action failed";
    }
    lines.push(`${r.step}. ${r.action}${label}: ${status} — ${message} (${r.durationMs}ms)`);
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

export const batchCommandSchema = z.object({
  name: z.string().describe("Tool name (e.g., 'input_tap', 'system_wait', 'input_text')"),
  arguments: z.record(z.string(), z.unknown()).optional().describe("Tool arguments"),
});

export const flowStepSchema = z.object({
  action: z.string().describe("Any registered tool name except shell, browser-evaluation, and debugger-evaluation/mutation tools"),
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
