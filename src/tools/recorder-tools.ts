import type { ToolDefinition } from "./registry.js";
import { getRegisteredToolNames } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { ScenarioStore, MAX_STEPS_PER_SCENARIO } from "../utils/scenario-store.js";
import type { Scenario, ScenarioStep, ScenarioEntry } from "../utils/scenario-store.js";
import { createLazySingleton } from "../utils/lazy.js";
import { truncateOutput } from "../utils/truncate.js";
import { createHash } from "crypto";
import {
  RecorderAlreadyActiveError,
  RecorderNotActiveError,
  ValidationError,
  MobileError,
} from "../errors.js";

const getStore = createLazySingleton(() => new ScenarioStore());

// ── Recording state ──

interface RecordingState {
  name: string;
  platform: string;
  description: string;
  tags: string[];
  steps: ScenarioStep[];
  startedAt: number;
  lastStepAt: number;
}

let activeRecording: RecordingState | null = null;

// ── Recording blocklist ──

const RECORDING_BLOCKLIST = new Set([
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
const PLAYBACK_BLOCKED_ACTIONS = new Set([
  "system_shell", "shell",
  "browser_evaluate",
  "recorder_start", "recorder_stop", "recorder_play",
  "recorder", "install_app", "push_file",
]);

// ── Step classification ──

function classifyStepType(action: string): ScenarioStep["type"] {
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

function isSensitiveInput(action: string, args: Record<string, unknown>): boolean {
  if (!action.includes("text") && !action.includes("fill")) return false;
  const text = String(args.text ?? args.value ?? "");
  const resourceId = String(args.resourceId ?? args.id ?? args.selector ?? "");
  if (SENSITIVE_PATTERNS.test(resourceId)) return true;
  // Looks like a token (long base64-ish string)
  if (/^[A-Za-z0-9+/=_\-]{40,}$/.test(text)) return true;
  return false;
}

// ── Public recording API (called from index.ts handleTool) ──

export function isRecording(): boolean {
  return activeRecording !== null;
}

export function captureStep(action: string, args: Record<string, unknown>, depth: number): void {
  if (!activeRecording) return;
  if (depth !== 0) return;
  if (RECORDING_BLOCKLIST.has(action)) return;
  if (activeRecording.steps.length >= MAX_STEPS_PER_SCENARIO) return;

  const now = Date.now();
  const delayBeforeMs = activeRecording.steps.length === 0
    ? 0
    : now - activeRecording.lastStepAt;

  const sensitive = isSensitiveInput(action, args);
  const cleanArgs = { ...args };
  // Remove platform — inherited from scenario
  delete cleanArgs.platform;
  if (sensitive) {
    if ("text" in cleanArgs) cleanArgs.text = "[REDACTED]";
    if ("value" in cleanArgs) cleanArgs.value = "[REDACTED]";
  }

  const step: ScenarioStep = {
    index: activeRecording.steps.length,
    type: classifyStepType(action),
    action,
    args: cleanArgs,
    timestampMs: now - activeRecording.startedAt,
    delayBeforeMs,
    ...(sensitive ? { sensitive: true } : {}),
  };

  activeRecording.steps.push(step);
  activeRecording.lastStepAt = now;
}

// ── Helpers ──

function formatEntry(e: ScenarioEntry): string {
  const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
  const date = e.updatedAt.split("T")[0];
  return `${e.name} (${e.platform}) — ${e.stepCount} steps, ${date}${tags}`;
}

function formatStepCompact(step: ScenarioStep, i: number): string {
  const label = step.label ? ` (${step.label})` : "";
  const sensitive = step.sensitive ? " *" : "";
  const argsStr = Object.keys(step.args).length > 0
    ? ` {${Object.entries(step.args).map(([k, v]) => `${k}:${JSON.stringify(v)}`).join(", ")}}`
    : "";
  return `  ${i + 1}. [${step.type}] ${step.action}${argsStr}${label}${sensitive}`;
}

// ── Playback engine ──

const PLAYBACK_MAX_STEP_TIMEOUT = 30_000;
const PLAYBACK_MAX_DURATION = 120_000;
const PLAYBACK_MAX_SPEED = 10;

interface PlaybackResult {
  step: number;
  action: string;
  label?: string;
  status: "OK" | "FAIL" | "SKIP";
  message: string;
  durationMs: number;
}

async function executePlayback(
  scenario: Scenario,
  ctx: ToolContext,
  options: {
    speed?: number;
    stopOnFail?: boolean;
    stepTimeout?: number;
    maxDuration?: number;
    fromStep?: number;
    toStep?: number;
    dryRun?: boolean;
  },
  depth: number,
): Promise<{ results: PlaybackResult[]; totalMs: number }> {
  const speed = Math.min(Math.max(options.speed ?? 1, 0), PLAYBACK_MAX_SPEED);
  const stopOnFail = options.stopOnFail !== false;
  const stepTimeout = Math.min(options.stepTimeout ?? 5000, PLAYBACK_MAX_STEP_TIMEOUT);
  const maxDuration = Math.min(options.maxDuration ?? 60000, PLAYBACK_MAX_DURATION);
  const fromStep = Math.max((options.fromStep ?? 1) - 1, 0);
  const toStep = Math.min(options.toStep ?? scenario.steps.length, scenario.steps.length);
  const dryRun = options.dryRun === true;

  // Pre-validate all actions
  for (const step of scenario.steps) {
    if (PLAYBACK_BLOCKED_ACTIONS.has(step.action)) {
      throw new MobileError(
        `Action "${step.action}" is blocked in scenario playback for security`,
        "SCENARIO_ACTION_BLOCKED"
      );
    }
    if (!getRegisteredToolNames().has(step.action)) {
      throw new MobileError(
        `Unknown action "${step.action}" in scenario`,
        "SCENARIO_UNKNOWN_ACTION"
      );
    }
  }

  const results: PlaybackResult[] = [];
  const playbackStart = Date.now();

  for (let i = fromStep; i < toStep; i++) {
    const step = scenario.steps[i];

    // Total duration guard
    if (Date.now() - playbackStart > maxDuration) {
      results.push({
        step: i + 1, action: step.action, label: step.label,
        status: "FAIL", message: "Max duration exceeded", durationMs: 0,
      });
      break;
    }

    if (dryRun) {
      results.push({
        step: i + 1, action: step.action, label: step.label,
        status: "SKIP", message: "dry-run", durationMs: 0,
      });
      continue;
    }

    // Inter-step delay
    if (step.delayBeforeMs > 0 && speed > 0) {
      await new Promise(r => setTimeout(r, Math.round(step.delayBeforeMs / speed)));
    }

    const stepStart = Date.now();
    try {
      const result = await Promise.race([
        ctx.handleTool(step.action, { ...step.args, platform: scenario.platform }, depth + 1),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Step timeout")), stepTimeout)),
      ]);

      const text = typeof result === "object" && result !== null && "text" in result
        ? truncateOutput((result as { text: string }).text, { maxChars: 200, maxLines: 5 })
        : "OK";

      results.push({
        step: i + 1, action: step.action, label: step.label,
        status: "OK", message: text, durationMs: Date.now() - stepStart,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const onError = step.onError ?? (stopOnFail ? "stop" : "skip");

      results.push({
        step: i + 1, action: step.action, label: step.label,
        status: "FAIL", message: truncateOutput(msg, { maxChars: 200, maxLines: 3 }),
        durationMs: Date.now() - stepStart,
      });

      if (onError === "stop") break;
      // "skip" — continue to next step
      // "retry" — retry once
      if (onError === "retry") {
        try {
          await ctx.handleTool(step.action, { ...step.args, platform: scenario.platform }, depth + 1);
          // Overwrite last result with success
          results[results.length - 1] = {
            step: i + 1, action: step.action, label: step.label,
            status: "OK", message: "OK (retry)", durationMs: Date.now() - stepStart,
          };
        } catch {
          // Retry also failed — keep the FAIL result
          if (stopOnFail) break;
        }
      }
    }
  }

  return { results, totalMs: Date.now() - playbackStart };
}

function formatPlaybackResults(scenario: Scenario, results: PlaybackResult[], totalMs: number): string {
  const passed = results.filter(r => r.status === "OK").length;
  const failed = results.filter(r => r.status === "FAIL").length;
  const total = scenario.steps.length;

  const statusLine = failed > 0
    ? `Playback FAILED: ${scenario.name} (${scenario.platform}) — ${passed}/${total} OK, ${failed} FAILED (${totalMs}ms)`
    : `Playback OK: ${scenario.name} (${scenario.platform}) — ${passed}/${total} OK (${totalMs}ms)`;

  const lines = results.map(r => {
    const label = r.label ? ` (${r.label})` : "";
    return `  ${r.step}. ${r.action}${label}: ${r.status} — ${r.message} (${r.durationMs}ms)`;
  });

  return `${statusLine}\n\n${lines.join("\n")}`;
}

// ── Tool definitions ──

export const recorderTools: ToolDefinition[] = [
  // 1. start
  {
    tool: {
      name: "recorder_start",
      description: "Begin recording user interactions as a test scenario",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Scenario name (e.g. 'login-flow')" },
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
            description: "Target platform",
          },
          tags: { type: "array", items: { type: "string" }, description: "Tags for categorizing" },
          description: { type: "string", description: "Scenario description" },
          overwrite: { type: "boolean", description: "Overwrite existing (default: false)", default: false },
        },
        required: ["name"],
      },
    },
    handler: async (args, ctx) => {
      const name = args.name as string;
      if (!name) throw new ValidationError("name is required for recorder start");

      if (activeRecording) {
        throw new RecorderAlreadyActiveError(activeRecording.name);
      }

      const platform = (args.platform as string) ?? ctx.deviceManager.getCurrentPlatform() ?? "android";

      // Check if scenario exists (unless overwrite)
      if (args.overwrite !== true) {
        const existing = await getStore().list(platform);
        if (existing.some(e => e.name === name)) {
          const entry = existing.find(e => e.name === name)!;
          throw new MobileError(
            `Scenario "${name}" already exists for platform "${platform}" (${entry.stepCount} steps). Use overwrite:true or recorder(action:'delete').`,
            "SCENARIO_EXISTS"
          );
        }
      }

      activeRecording = {
        name,
        platform,
        description: (args.description as string) ?? "",
        tags: (args.tags as string[]) ?? [],
        steps: [],
        startedAt: Date.now(),
        lastStepAt: Date.now(),
      };

      return { text: `Recording started: "${name}" (${platform}). All tool calls will be captured. Use recorder(action:'stop') to save.` };
    },
  },

  // 2. stop
  {
    tool: {
      name: "recorder_stop",
      description: "Stop recording and save scenario (or discard)",
      inputSchema: {
        type: "object",
        properties: {
          discard: { type: "boolean", description: "Discard without saving (default: false)", default: false },
        },
      },
    },
    handler: async (args) => {
      if (!activeRecording) throw new RecorderNotActiveError();

      const recording = activeRecording;
      activeRecording = null;

      if (args.discard === true) {
        return { text: `Recording discarded: "${recording.name}" — ${recording.steps.length} steps dropped.` };
      }

      // Re-index steps
      recording.steps.forEach((s, i) => { s.index = i; });

      const store = getStore();
      const now = new Date().toISOString();
      const checksum = createHash("sha256")
        .update(JSON.stringify(recording.steps))
        .digest("hex");

      const scenario: Scenario = {
        version: 1,
        name: recording.name,
        platform: recording.platform,
        description: recording.description,
        tags: recording.tags,
        createdAt: now,
        updatedAt: now,
        checksum,
        steps: recording.steps,
        metadata: {
          recordedWithVersion: "3.5.0",
          totalRecordingTimeMs: Date.now() - recording.startedAt,
        },
      };

      const entry = await store.save(scenario, { overwrite: true });
      return { text: `Recording saved: "${entry.name}" (${entry.platform}) — ${entry.stepCount} steps` };
    },
  },

  // 3. status
  {
    tool: {
      name: "recorder_status",
      description: "Get current recording state",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => {
      if (!activeRecording) {
        return { text: "No recording in progress. Use recorder(action:'start') to begin." };
      }

      const elapsed = Date.now() - activeRecording.startedAt;
      const lines = [
        `Recording: "${activeRecording.name}" (${activeRecording.platform})`,
        `Steps: ${activeRecording.steps.length} | Elapsed: ${(elapsed / 1000).toFixed(1)}s`,
      ];

      if (activeRecording.steps.length > 0) {
        const last5 = activeRecording.steps.slice(-5);
        lines.push("", "Recent steps:");
        last5.forEach((s, i) => lines.push(formatStepCompact(s, activeRecording!.steps.length - last5.length + i)));
      }

      return { text: lines.join("\n") };
    },
  },

  // 4. add_step
  {
    tool: {
      name: "recorder_add_step",
      description: "Manually add a step to the active recording",
      inputSchema: {
        type: "object",
        properties: {
          action_name: { type: "string", description: "Tool action name (e.g. 'ui_assert_visible')" },
          args: { type: "object", description: "Step arguments" },
          label: { type: "string", description: "Human-readable label" },
        },
        required: ["action_name"],
      },
    },
    handler: async (args) => {
      if (!activeRecording) throw new RecorderNotActiveError();

      const actionName = args.action_name as string;
      if (!actionName) throw new ValidationError("action_name is required");

      if (activeRecording.steps.length >= MAX_STEPS_PER_SCENARIO) {
        throw new ValidationError(`Max steps (${MAX_STEPS_PER_SCENARIO}) reached`);
      }

      const now = Date.now();
      const step: ScenarioStep = {
        index: activeRecording.steps.length,
        type: classifyStepType(actionName),
        action: actionName,
        args: (args.args as Record<string, unknown>) ?? {},
        timestampMs: now - activeRecording.startedAt,
        delayBeforeMs: 0,
        ...(args.label ? { label: args.label as string } : {}),
      };

      activeRecording.steps.push(step);
      activeRecording.lastStepAt = now;

      return { text: `+${step.index + 1}. ${step.action}${step.label ? ` (${step.label})` : ""} (added)` };
    },
  },

  // 5. remove_step
  {
    tool: {
      name: "recorder_remove_step",
      description: "Remove a step from the active recording by index",
      inputSchema: {
        type: "object",
        properties: {
          stepIndex: { type: "number", description: "Step index to remove (1-based)" },
        },
        required: ["stepIndex"],
      },
    },
    handler: async (args) => {
      if (!activeRecording) throw new RecorderNotActiveError();

      const idx = (args.stepIndex as number) - 1;
      if (idx < 0 || idx >= activeRecording.steps.length) {
        throw new ValidationError(`Step index out of range. Valid: 1-${activeRecording.steps.length}`);
      }

      const removed = activeRecording.steps.splice(idx, 1)[0];
      // Re-index
      activeRecording.steps.forEach((s, i) => { s.index = i; });

      return { text: `-${idx + 1}. ${removed.action} (removed). ${activeRecording.steps.length} steps remaining.` };
    },
  },

  // 6. list
  {
    tool: {
      name: "recorder_list",
      description: "List saved test scenarios",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
            description: "Filter by platform",
          },
          tag: { type: "string", description: "Filter by tag" },
        },
      },
    },
    handler: async (args) => {
      const platform = args.platform as string | undefined;
      const tag = args.tag as string | undefined;
      const entries = await getStore().list(platform, tag);

      if (entries.length === 0) {
        const filter = [platform, tag].filter(Boolean).join(", ");
        return { text: `No scenarios found${filter ? ` (filter: ${filter})` : ""}. Use recorder(action:'start') to create one.` };
      }

      const header = `Scenarios${platform ? ` (${platform})` : ""}: ${entries.length} total`;
      const list = entries.map((e, i) => `  ${i + 1}. ${formatEntry(e)}`).join("\n");
      return { text: `${header}\n${list}` };
    },
  },

  // 7. show
  {
    tool: {
      name: "recorder_show",
      description: "Display contents of a saved scenario",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Scenario name" },
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
          },
        },
        required: ["name"],
      },
    },
    handler: async (args, ctx) => {
      const name = args.name as string;
      if (!name) throw new ValidationError("name is required");
      const platform = (args.platform as string) ?? ctx.deviceManager.getCurrentPlatform() ?? "android";

      const scenario = await getStore().get(name, platform);
      const tags = scenario.tags.length > 0 ? `\nTags: ${scenario.tags.join(", ")}` : "";
      const desc = scenario.description ? `\nDescription: ${scenario.description}` : "";

      const lines = [
        `Scenario: ${scenario.name} (${scenario.platform}) — ${scenario.steps.length} steps${desc}${tags}`,
        `Created: ${scenario.createdAt.split("T")[0]}`,
        "",
        "Steps:",
      ];

      scenario.steps.forEach((step, i) => {
        lines.push(formatStepCompact(step, i));
      });

      return { text: lines.join("\n") };
    },
  },

  // 8. delete
  {
    tool: {
      name: "recorder_delete",
      description: "Delete a saved scenario",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Scenario name" },
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
          },
        },
        required: ["name"],
      },
    },
    handler: async (args, ctx) => {
      const name = args.name as string;
      if (!name) throw new ValidationError("name is required");
      const platform = (args.platform as string) ?? ctx.deviceManager.getCurrentPlatform() ?? "android";

      await getStore().delete(name, platform);
      return { text: `Deleted scenario: ${name} (${platform})` };
    },
  },

  // 9. play
  {
    tool: {
      name: "recorder_play",
      description: "Replay a saved scenario. Executes all steps sequentially with optional speed/timeout control.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Scenario name" },
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
          },
          speed: { type: "number", description: "Speed multiplier (default: 1.0, 0 = no delays)", default: 1.0 },
          stopOnFail: { type: "boolean", description: "Stop on first failure (default: true)", default: true },
          stepTimeout: { type: "number", description: "Per-step timeout ms (default: 5000)", default: 5000 },
          maxDuration: { type: "number", description: "Max total ms (default: 60000)", default: 60000 },
          fromStep: { type: "number", description: "Start from step N (1-indexed)" },
          toStep: { type: "number", description: "End at step N (1-indexed)" },
          dryRun: { type: "boolean", description: "Print steps without executing", default: false },
        },
        required: ["name"],
      },
    },
    handler: async (args, ctx, depth = 0) => {
      const name = args.name as string;
      if (!name) throw new ValidationError("name is required for play");

      if (activeRecording) {
        throw new MobileError(
          "Cannot play while recording. Use recorder(action:'stop') first.",
          "RECORDER_ALREADY_ACTIVE"
        );
      }

      const platform = (args.platform as string) ?? ctx.deviceManager.getCurrentPlatform() ?? "android";
      const scenario = await getStore().get(name, platform);

      const { results, totalMs } = await executePlayback(scenario, ctx, {
        speed: args.speed as number,
        stopOnFail: args.stopOnFail as boolean,
        stepTimeout: args.stepTimeout as number,
        maxDuration: args.maxDuration as number,
        fromStep: args.fromStep as number,
        toStep: args.toStep as number,
        dryRun: args.dryRun as boolean,
      }, depth);

      const text = formatPlaybackResults(scenario, results, totalMs);
      const failed = results.some(r => r.status === "FAIL");

      return { text, ...(failed ? { isError: true } : {}) };
    },
  },

  // 10. export
  {
    tool: {
      name: "recorder_export",
      description: "Export scenario as flow_steps (for flow_run) or markdown checklist",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Scenario name" },
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop", "aurora", "browser"],
          },
          format: { type: "string", enum: ["flow_steps", "markdown"], description: "Export format (default: flow_steps)" },
        },
        required: ["name"],
      },
    },
    handler: async (args, ctx) => {
      const name = args.name as string;
      if (!name) throw new ValidationError("name is required for export");
      const platform = (args.platform as string) ?? ctx.deviceManager.getCurrentPlatform() ?? "android";
      const format = (args.format as string) ?? "flow_steps";
      const scenario = await getStore().get(name, platform);

      if (format === "markdown") {
        const lines = [
          `# Scenario: ${scenario.name} (${scenario.platform})`,
          "",
        ];
        scenario.steps.forEach((step, i) => {
          const label = step.label ? ` (${step.label})` : "";
          const argsStr = Object.keys(step.args).length > 0
            ? ` ${JSON.stringify(step.args)}`
            : "";
          lines.push(`- [ ] ${i + 1}. ${step.action}${argsStr}${label}`);
        });
        return { text: `Exported ${scenario.name} as markdown:\n\n${lines.join("\n")}` };
      }

      // flow_steps format
      const flowSteps = scenario.steps.map(step => ({
        action: step.action,
        args: step.args,
        ...(step.label ? { label: step.label } : {}),
        on_error: step.onError ?? "stop",
      }));

      const json = JSON.stringify({ steps: flowSteps }, null, 2);
      return { text: `Exported ${scenario.name} as flow_steps (${scenario.steps.length} steps):\n\n${json}\n\nUse with: flow(action:'run', steps: <above>)` };
    },
  },
];
