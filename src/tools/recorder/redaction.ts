import type { ScenarioStep } from "../../utils/scenario-store.js";

// ── Recording blocklist ──

export const RECORDING_BLOCKLIST = new Set([
  // Recorder itself — prevent recursion
  "recorder_start", "recorder_stop", "recorder_status",
  "recorder_add_step", "recorder_remove_step", "recorder_list",
  "recorder_show", "recorder_delete", "recorder_play", "recorder_export",
  "recorder", // meta-tool
  // Flow orchestration — record leaf calls, not wrappers
  "flow_batch", "flow_run", "flow_parallel",
  "batch_commands", "run_flow", "parallel",
  // Security-sensitive
  "system_shell", "shell",
  "browser_evaluate",
  // Sync orchestration — record leaf calls, not wrappers
  "sync_create_group", "sync_run", "sync_assert_cross",
  "sync_status", "sync_list", "sync_destroy",
  "sync",
]);

// Playback blocklist — superset of recording blocklist
export const PLAYBACK_BLOCKED_ACTIONS = new Set([
  "system_shell", "shell",
  "browser_evaluate",
  "recorder_start", "recorder_stop", "recorder_play",
  "recorder", "install_app", "push_file",
]);

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
