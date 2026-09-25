import type { ScenarioStep } from "../../utils/scenario-store.js";
import { resolveToolIdentity } from "../registry.js";

// ── Recording blocklist ──

export const RECORDING_BLOCKLIST: Readonly<Record<string, true>> = {
  // Recorder itself — prevent recursion
  recorder_start: true,
  recorder_stop: true,
  recorder_status: true,
  recorder_add_step: true,
  recorder_remove_step: true,
  recorder_list: true,
  recorder_show: true,
  recorder_delete: true,
  recorder_play: true,
  recorder_export: true,
  recorder: true,
  // Flow orchestration — record leaf calls, not wrappers
  flow_batch: true,
  flow_run: true,
  flow_parallel: true,
  batch_commands: true,
  run_flow: true,
  parallel: true,
  // Device mutation — installs, uninstalls, and file uploads are not replay-safe.
  app_install: true,
  app_uninstall: true,
  system_file_push: true,
  install_app: true,
  uninstall_app: true,
  push_file: true,
  // Security-sensitive
  system_shell: true,
  shell: true,
  browser_evaluate: true,
  debug_eval: true,
  debug_set_var: true,
  // REPL spawning executes an arbitrary command and is not replay-safe.
  repl_spawn: true,
  // Sync orchestration — record leaf calls, not wrappers
  sync_create_group: true,
  sync_run: true,
  sync_assert_cross: true,
  sync_status: true,
  sync_list: true,
  sync_destroy: true,
  sync: true,
};

// Playback blocklist — superset of recording blocklist
export const PLAYBACK_BLOCKED_ACTIONS: Readonly<Record<string, true>> = {
  // Device mutation — installs, uninstalls, and file uploads are not replay-safe.
  app_install: true,
  app_uninstall: true,
  system_file_push: true,
  install_app: true,
  uninstall_app: true,
  push_file: true,
  system_shell: true,
  shell: true,
  browser_evaluate: true,
  debug_eval: true,
  debug_set_var: true,
  // REPL process commands are not replay-safe.
  repl_spawn: true,
  repl_send: true,
  recorder_start: true,
  recorder_stop: true,
  recorder_play: true,
  recorder: true,
};

function isBlockedAction(
  action: string,
  args: Record<string, unknown>,
  blocklist: Readonly<Record<string, true>>,
): boolean {
  if (Object.hasOwn(blocklist, action)) return true;
  const identity = resolveToolIdentity(action, args);
  const canonical = identity?.canonical ?? action;
  const effectiveArgs = identity?.args ?? args;
  if (Object.hasOwn(blocklist, canonical)) return true;
  const subAction = effectiveArgs.action;
  return typeof subAction === "string"
    && Object.hasOwn(blocklist, `${canonical}_${subAction}`);
}

export function isRecordingBlockedAction(
  action: string,
  args: Record<string, unknown> = {},
): boolean {
  return isBlockedAction(action, args, RECORDING_BLOCKLIST);
}

export function isPlaybackBlockedAction(
  action: string,
  args: Record<string, unknown> = {},
): boolean {
  return isBlockedAction(action, args, PLAYBACK_BLOCKED_ACTIONS);
}


// ── Step classification ──

export function classifyStepType(action: string): ScenarioStep["type"] {
  if (action.startsWith("visual_")) return "visual";
  if (action.includes("assert") || action.includes("wait_for")) return "assert";
  if (action === "system_wait" || action === "wait") return "wait";
  if (action.includes("swipe") || action.includes("long_press") || action.includes("double_tap")) return "gesture";
  if (action.includes("tap") || action.includes("click")) return "gesture";
  if (action.includes("launch") || action.includes("open_url") || action.includes("navigate")) return "navigate";
  if (action.includes("text") || action.includes("fill") || action.includes("input_text")) return "data_input";
  return "tool_call";
}

// ── Sensitive input detection ──

const SENSITIVE_PATTERNS =
  /password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|apikey|auth|credential|pin|otp/i;
const REDACTED_INPUT = "[REDACTED]";
// The recorder cannot infer whether text typed into a focused field is sensitive.
const SENSITIVE_TEXT_ACTIONS = new Set([
  "input_text",
  "repl_send",
  "clipboard_set",
  "desktop_clipboard_set",
]);

function hasSensitiveProperty(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      for (const nestedValue of current) pending.push(nestedValue);
      continue;
    }
    if (current === null || typeof current !== "object") continue;

    for (const [key, nestedValue] of Object.entries(current)) {
      if (SENSITIVE_PATTERNS.test(key)) return true;
      pending.push(nestedValue);
    }
  }
  return false;
}

export function isSensitiveInput(action: string, args: Record<string, unknown>): boolean {
  const identity = resolveToolIdentity(action, args);
  const effectiveArgs = identity?.args ?? args;
  const effectiveAction = identity?.canonical ?? action;
  const subAction = effectiveArgs.action;
  const classifiedAction = typeof subAction === "string"
    ? `${effectiveAction}_${subAction}`
    : effectiveAction;

  if (hasSensitiveProperty(effectiveArgs)) return true;
  if (SENSITIVE_TEXT_ACTIONS.has(classifiedAction)) return true;
  // Form-fill values are user data, and selectors are not reliable enough to
  // tell credentials from ordinary account details.
  if (classifiedAction.startsWith("browser_") && classifiedAction.includes("fill")) return true;
  if (!classifiedAction.includes("text") && !classifiedAction.includes("fill")) return false;

  const text = String(effectiveArgs.text ?? effectiveArgs.value ?? "");
  const resourceId = String(
    effectiveArgs.resourceId ?? effectiveArgs.id ?? effectiveArgs.selector ?? "",
  );
  if (SENSITIVE_PATTERNS.test(resourceId) || SENSITIVE_PATTERNS.test(text)) return true;
  // Looks like a token (long base64-ish string)
  if (/^[A-Za-z0-9+/=_\-]{40,}$/.test(text)) return true;
  return false;
}

function maskSensitiveValues(args: Record<string, unknown>): Record<string, unknown> {
  const maskTree = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(maskTree);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        key === "text"
          || key === "value"
          || SENSITIVE_PATTERNS.test(key)
          ? REDACTED_INPUT
          : maskTree(nestedValue),
      ]),
    );
  };

  return maskTree(args) as Record<string, unknown>;
}

export function redactSensitiveArgs(
  action: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; sensitive: boolean } {
  const sensitive = isSensitiveInput(action, args);
  return {
    args: sensitive ? maskSensitiveValues(args) : { ...args },
    sensitive,
  };
}

const SENSITIVE_LABEL_KEY =
  "(?:[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|apikey|auth\\w*|credential|pin|otp)[A-Za-z0-9_-]*)";
const SENSITIVE_LABEL_KEY_VALUE = new RegExp(
  `(\\b${SENSITIVE_LABEL_KEY}\\b\\s*[:=]\\s*)(.*?)(?=\\s+[A-Za-z][\\w-]*\\s*[:=]|\\s*[,;|]|$)`,
  "gis",
);
const SENSITIVE_LABEL_PATTERN = new RegExp(`\\b${SENSITIVE_LABEL_KEY}\\b`, "i");

/**
 * Labels are user-authored display text, so they need the same egress
 * guarantees as step arguments. A step already known to be sensitive gets a
 * generic marker; otherwise preserve an explicit credential key while hiding
 * only its value.
 */
export function redactScenarioLabel(label: string | undefined, sensitive = false): string | undefined {
  if (!label) return label;
  if (sensitive) return REDACTED_INPUT;

  const redactedValue = label.replace(SENSITIVE_LABEL_KEY_VALUE, `$1${REDACTED_INPUT}`);
  if (redactedValue !== label) return redactedValue;
  return SENSITIVE_LABEL_PATTERN.test(label) ? REDACTED_INPUT : label;
}

/** Sanitize older persisted steps as well as newly recorded ones before output. */
export function redactScenarioStep(step: ScenarioStep): ScenarioStep {
  const result = redactSensitiveArgs(step.action, step.args);
  const sensitive = step.sensitive === true || result.sensitive;
  const label = redactScenarioLabel(step.label, sensitive);
  return {
    ...step,
    args: step.sensitive === true ? maskSensitiveValues(step.args) : result.args,
    ...(label !== undefined ? { label } : {}),
    ...(sensitive ? { sensitive: true } : {}),
  };
}

