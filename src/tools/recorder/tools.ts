import type { ToolDefinition } from "../registry.js";
import { ScenarioStore, MAX_STEPS_PER_SCENARIO } from "../../utils/scenario-store.js";
import type { Scenario, ScenarioStep } from "../../utils/scenario-store.js";
import { createLazySingleton } from "../../utils/lazy.js";
import { createHash } from "crypto";
import {
  RecorderAlreadyActiveError,
  RecorderNotActiveError,
  ValidationError,
  MobileError,
} from "../../errors.js";
import { defineTool, z } from "../define-tool.js";
import { platformEnum } from "../common-schema.js";
import { textResult } from "../../utils/tool-result.js";
import { getActive, setActive } from "./capture.js";
import { classifyStepType } from "./redaction.js";
import {
  executePlayback,
  formatEntry,
  formatPlaybackResults,
  formatStepCompact,
} from "./playback.js";

const getStore = createLazySingleton(() => new ScenarioStore());

// ── Tool definitions ──

export const recorderTools: ToolDefinition[] = [
  // 1. start
  defineTool({
    name: "recorder_start",
    description: "Begin recording user interactions as a test scenario",
    schema: z.object({
      name: z
        .string({ error: "name is required for recorder start" })
        .min(1, "name is required for recorder start")
        .describe("Scenario name (e.g. 'login-flow')"),
      platform: platformEnum,
      tags: z.array(z.string()).optional().describe("Tags for categorizing"),
      description: z.string().optional().describe("Scenario description"),
      overwrite: z.boolean().optional().describe("Overwrite existing (default: false)"),
    }),
    handler: async (args, ctx) => {
      const name = args.name;

      const existingActive = getActive();
      if (existingActive) {
        throw new RecorderAlreadyActiveError(existingActive.name);
      }

      const platform = args.platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";

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

      setActive({
        name,
        platform,
        description: args.description ?? "",
        tags: args.tags ?? [],
        steps: [],
        startedAt: Date.now(),
        lastStepAt: Date.now(),
      });

      return textResult(`Recording started: "${name}" (${platform}). All tool calls will be captured. Use recorder(action:'stop') to save.`);
    },
  }),

  // 2. stop
  defineTool({
    name: "recorder_stop",
    description: "Stop recording and save scenario (or discard)",
    schema: z.object({
      discard: z.boolean().optional().describe("Discard without saving (default: false)"),
    }),
    handler: async (args) => {
      const activeRecording = getActive();
      if (!activeRecording) throw new RecorderNotActiveError();

      const recording = activeRecording;
      setActive(null);

      if (args.discard === true) {
        return textResult(`Recording discarded: "${recording.name}" — ${recording.steps.length} steps dropped.`);
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
      return textResult(`Recording saved: "${entry.name}" (${entry.platform}) — ${entry.stepCount} steps`);
    },
  }),

  // 3. status
  defineTool({
    name: "recorder_status",
    description: "Get current recording state",
    schema: z.object({}),
    handler: async () => {
      const activeRecording = getActive();
      if (!activeRecording) {
        return textResult("No recording in progress. Use recorder(action:'start') to begin.");
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

      return textResult(lines.join("\n"));
    },
  }),

  // 4. add_step
  defineTool({
    name: "recorder_add_step",
    description: "Manually add a step to the active recording",
    schema: z.object({
      action_name: z
        .string({ error: "action_name is required" })
        .min(1, "action_name is required")
        .describe("Tool action name (e.g. 'ui_assert_visible')"),
      args: z.record(z.string(), z.unknown()).optional().describe("Step arguments"),
      label: z.string().optional().describe("Human-readable label"),
    }),
    handler: async (args) => {
      const activeRecording = getActive();
      if (!activeRecording) throw new RecorderNotActiveError();

      const actionName = args.action_name;

      if (activeRecording.steps.length >= MAX_STEPS_PER_SCENARIO) {
        throw new ValidationError(`Max steps (${MAX_STEPS_PER_SCENARIO}) reached`);
      }

      const now = Date.now();
      const step: ScenarioStep = {
        index: activeRecording.steps.length,
        type: classifyStepType(actionName),
        action: actionName,
        args: args.args ?? {},
        timestampMs: now - activeRecording.startedAt,
        delayBeforeMs: 0,
        ...(args.label ? { label: args.label } : {}),
      };

      activeRecording.steps.push(step);
      activeRecording.lastStepAt = now;

      return textResult(`+${step.index + 1}. ${step.action}${step.label ? ` (${step.label})` : ""} (added)`);
    },
  }),

  // 5. remove_step
  defineTool({
    name: "recorder_remove_step",
    description: "Remove a step from the active recording by index",
    schema: z.object({
      stepIndex: z.number().describe("Step index to remove (1-based)"),
    }),
    handler: async (args) => {
      const activeRecording = getActive();
      if (!activeRecording) throw new RecorderNotActiveError();

      const idx = args.stepIndex - 1;
      if (idx < 0 || idx >= activeRecording.steps.length) {
        throw new ValidationError(`Step index out of range. Valid: 1-${activeRecording.steps.length}`);
      }

      const removed = activeRecording.steps.splice(idx, 1)[0];
      // Re-index
      activeRecording.steps.forEach((s, i) => { s.index = i; });

      return textResult(`-${idx + 1}. ${removed.action} (removed). ${activeRecording.steps.length} steps remaining.`);
    },
  }),

  // 6. list
  defineTool({
    name: "recorder_list",
    description: "List saved test scenarios",
    schema: z.object({
      platform: platformEnum,
      tag: z.string().optional().describe("Filter by tag"),
    }),
    handler: async (args) => {
      const platform = args.platform;
      const tag = args.tag;
      const entries = await getStore().list(platform, tag);

      if (entries.length === 0) {
        const filter = [platform, tag].filter(Boolean).join(", ");
        return textResult(`No scenarios found${filter ? ` (filter: ${filter})` : ""}. Use recorder(action:'start') to create one.`);
      }

      const header = `Scenarios${platform ? ` (${platform})` : ""}: ${entries.length} total`;
      const list = entries.map((e, i) => `  ${i + 1}. ${formatEntry(e)}`).join("\n");
      return textResult(`${header}\n${list}`);
    },
  }),

  // 7. show
  defineTool({
    name: "recorder_show",
    description: "Display contents of a saved scenario",
    schema: z.object({
      name: z
        .string({ error: "name is required" })
        .min(1, "name is required")
        .describe("Scenario name"),
      platform: platformEnum,
    }),
    handler: async (args, ctx) => {
      const name = args.name;
      const platform = args.platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";

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

      return textResult(lines.join("\n"));
    },
  }),

  // 8. delete
  defineTool({
    name: "recorder_delete",
    description: "Delete a saved scenario",
    schema: z.object({
      name: z
        .string({ error: "name is required" })
        .min(1, "name is required")
        .describe("Scenario name"),
      platform: platformEnum,
    }),
    handler: async (args, ctx) => {
      const name = args.name;
      const platform = args.platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";

      await getStore().delete(name, platform);
      return textResult(`Deleted scenario: ${name} (${platform})`);
    },
  }),

  // 9. play
  defineTool({
    name: "recorder_play",
    description:
      "Replay a saved scenario. Executes all steps sequentially with optional speed/timeout control.",
    schema: z.object({
      name: z
        .string({ error: "name is required for play" })
        .min(1, "name is required for play")
        .describe("Scenario name"),
      platform: platformEnum,
      speed: z
        .number()
        .optional()
        .describe("Speed multiplier (default: 1.0, 0 = no delays)"),
      stopOnFail: z.boolean().optional().describe("Stop on first failure (default: true)"),
      stepTimeout: z.number().optional().describe("Per-step timeout ms (default: 5000)"),
      maxDuration: z.number().optional().describe("Max total ms (default: 60000)"),
      fromStep: z.number().optional().describe("Start from step N (1-indexed)"),
      toStep: z.number().optional().describe("End at step N (1-indexed)"),
      dryRun: z.boolean().optional().describe("Print steps without executing"),
    }),
    handler: async (args, ctx, depth = 0) => {
      const name = args.name;

      if (getActive()) {
        throw new MobileError(
          "Cannot play while recording. Use recorder(action:'stop') first.",
          "RECORDER_ALREADY_ACTIVE"
        );
      }

      const platform = args.platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";
      const scenario = await getStore().get(name, platform);

      const { results, totalMs } = await executePlayback(scenario, ctx, {
        speed: args.speed,
        stopOnFail: args.stopOnFail,
        stepTimeout: args.stepTimeout,
        maxDuration: args.maxDuration,
        fromStep: args.fromStep,
        toStep: args.toStep,
        dryRun: args.dryRun,
      }, depth ?? 0);

      const text = formatPlaybackResults(scenario, results, totalMs);
      const failed = results.some(r => r.status === "FAIL");

      const result = textResult(text);
      if (failed) result.isError = true;
      return result;
    },
  }),

  // 10. export
  defineTool({
    name: "recorder_export",
    description: "Export scenario as flow_steps (for flow_run) or markdown checklist",
    schema: z.object({
      name: z
        .string({ error: "name is required for export" })
        .min(1, "name is required for export")
        .describe("Scenario name"),
      platform: platformEnum,
      format: z
        .enum(["flow_steps", "markdown"])
        .optional()
        .describe("Export format (default: flow_steps)"),
    }),
    handler: async (args, ctx) => {
      const name = args.name;
      const platform = args.platform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";
      const format = args.format ?? "flow_steps";
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
        return textResult(`Exported ${scenario.name} as markdown:\n\n${lines.join("\n")}`);
      }

      // flow_steps format
      const flowSteps = scenario.steps.map(step => ({
        action: step.action,
        args: step.args,
        ...(step.label ? { label: step.label } : {}),
        on_error: step.onError ?? "stop",
      }));

      const json = JSON.stringify({ steps: flowSteps }, null, 2);
      return textResult(`Exported ${scenario.name} as flow_steps (${scenario.steps.length} steps):\n\n${json}\n\nUse with: flow(action:'run', steps: <above>)`);
    },
  }),
];
