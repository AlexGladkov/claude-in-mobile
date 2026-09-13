import type { ScenarioStep } from "../../utils/scenario-store.js";

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
  // Security-sensitive
  system_shell: true,
  shell: true,
  browser_evaluate: true,
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
  system_shell: true,
  shell: true,
  browser_evaluate: true,
  recorder_start: true,
  recorder_stop: true,
  recorder_play: true,
  recorder: true,
  install_app: true,
  push_file: true,
};

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

const SENSITIVE_PATTERNS = /password|passwd|secret|token|api_key|apikey|auth|credential|pin|otp/i;

export function isSensitiveInput(action: string, args: Record<string, unknown>): boolean {
  if (!action.includes("text") && !action.includes("fill")) return false;
  const text = String(args.text ?? args.value ?? "");
  const resourceId = String(args.resourceId ?? args.id ?? args.selector ?? "");
  if (SENSITIVE_PATTERNS.test(resourceId)) return true;
  // Looks like a token (long base64-ish string)
  if (/^[A-Za-z0-9+/=_\-]{40,}$/.test(text)) return true;
  return false;
}
