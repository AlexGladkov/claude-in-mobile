import type { ToolDefinition } from "./registry.js";
import { getRegisteredToolNames } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { findElements, UiElement } from "../adb/ui-parser.js";
import { DeviceNotFoundError, DeviceOfflineError, AdbNotInstalledError, ValidationError, MobileError } from "../errors.js";
import { MAX_RECURSION_DEPTH } from "./context.js";
import { truncateOutput } from "../utils/truncate.js";

// Actions explicitly blocked from flow execution (security-sensitive).
// Everything else registered in the registry is allowed.
const FLOW_BLOCKED_ACTIONS = new Set([
  "system_shell",
  "browser_evaluate",
]);

/**
 * Check whether an action is allowed in flow_batch / flow_run / flow_parallel.
 *
 * Strategy: blocklist instead of allowlist. Any registered tool or alias is
 * allowed unless it is in FLOW_BLOCKED_ACTIONS. This eliminates the need
 * to maintain a 50+ entry hardcoded allowlist that goes stale with every
 * new tool or alias.
 */
function isFlowActionAllowed(actionName: string): boolean {
  if (FLOW_BLOCKED_ACTIONS.has(actionName)) return false;
  return getRegisteredToolNames().has(actionName);
}

const FLOW_MAX_STEPS = 20;
const BATCH_MAX_COMMANDS = 50;
const FLOW_MAX_DURATION = 60000;
const FLOW_MAX_REPEAT = 10;
const PARALLEL_MAX_DEVICES = 10;

interface FlowStep {
  action: string;
  args?: Record<string, unknown>;
  if_not_found?: "skip" | "scroll_down" | "scroll_up" | "fail";
  repeat?: { times?: number; until_found?: string; until_not_found?: string };
  on_error?: "stop" | "skip" | "retry";
  label?: string;
}

interface FlowStepResult {
  step: number;
  action: string;
  label?: string;
  success: boolean;
  message: string;
  durationMs: number;
}

/** Collect brief UI context for diagnostics on flow step failure */
async function collectFailureDiag(
  ctx: ToolContext,
  platform: string,
  stepIndex: number,
): Promise<string> {
  try {
    const elements = await Promise.race([
      ctx.getElementsForPlatform(platform),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("diag timeout")), 800)),
    ]);
    const interactive = elements.filter(
      (el: UiElement) => el.clickable || el.scrollable || el.className.includes("EditText"),
    );
    const limited = interactive.slice(0, 15);
    if (limited.length === 0) return "";
    const lines = limited.map((el: UiElement) => {
      const label = el.text || el.contentDesc || "";
      const shortClass = el.className.split(".").pop() ?? "";
      return `  ${shortClass}${label ? ` "${label}"` : ""} (${el.centerX},${el.centerY})`;
    });
    return `\n[DIAG:step${stepIndex}] Available UI:\n${lines.join("\n")}`;
  } catch {
    return ""; // silently skip diagnostics
  }
}

function formatFlowResults(results: FlowStepResult[], totalMs: number, diagBlock: string = ""): string {
  const lines: string[] = [`Flow completed (${totalMs}ms)`, ""];
  for (const r of results) {
    const label = r.label ? ` (${r.label})` : "";
    const status = r.success ? "OK" : "FAIL";
    lines.push(`${r.step}. ${r.action}${label}: ${status} — ${r.message} (${r.durationMs}ms)`);
  }
  return lines.join("\n") + diagBlock;
}

export const flowTools: ToolDefinition[] = [
  {
    tool: {
      name: "flow_batch",
      description: "Execute multiple commands in one round-trip",
      inputSchema: {
        type: "object",
        properties: {
          commands: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Tool name (e.g., 'input_tap', 'system_wait', 'input_text')" },
                arguments: { type: "object", description: "Tool arguments" },
              },
              required: ["name"],
            },
            description: "Array of commands to execute sequentially",
          },
          stopOnError: { type: "boolean", description: "Stop execution on first error (default: true)", default: true },
        },
        required: ["commands"],
      },
    },
    handler: async (args, ctx, _depth = 0) => {
      if (_depth! > MAX_RECURSION_DEPTH) {
        throw new Error(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded. Nested batch_commands/run_flow calls are limited to prevent stack overflow.`);
      }

      const commands = args.commands as Array<{ name: string; arguments?: Record<string, unknown> }>;
      const stopOnError = args.stopOnError !== false;

      if (!commands || commands.length === 0) {
        throw new ValidationError("No commands provided.");
      }

      if (commands.length > BATCH_MAX_COMMANDS) {
        throw new ValidationError(`Too many commands (${commands.length}). Maximum is ${BATCH_MAX_COMMANDS}.`);
      }

      // Validate all actions are allowed before executing any
      for (const cmd of commands) {
        if (!isFlowActionAllowed(cmd.name)) {
          throw new MobileError(
            `Action "${cmd.name}" is not allowed in flow_batch. Use only safe actions.`,
            "FLOW_SECURITY"
          );
        }
      }

      const results: Array<{ command: string; success: boolean; result: string }> = [];

      for (const cmd of commands) {
        try {
          const result = await ctx.handleTool(cmd.name, cmd.arguments ?? {}, (_depth ?? 0) + 1);
          const text = typeof result === "object" && result !== null && "text" in result
            ? (result as { text: string }).text
            : JSON.stringify(result);

          results.push({ command: cmd.name, success: true, result: truncateOutput(text, { maxChars: 500, maxLines: 20 }) });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          results.push({ command: cmd.name, success: false, result: msg });
          if (stopOnError) {
            break;
          }
        }
      }

      const output = results.map((r, i) =>
        `${i + 1}. ${r.command}: ${r.success ? "OK" : "ERROR"} — ${r.result}`
      ).join("\n");

      const failed = results.filter(r => !r.success).length;
      const summary = failed > 0
        ? `Batch: ${results.length}/${commands.length} executed, ${failed} failed`
        : `Batch: ${results.length} commands OK`;

      return { text: `${summary}\n\n${output}` };
    },
  },
  {
    tool: {
      name: "flow_run",
      description: "Multi-step automation flow with conditionals, loops, error handling. Max 20 steps.",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string", description: "Any registered tool name except system_shell and browser_evaluate" },
                args: { type: "object", description: "Tool arguments" },
                if_not_found: { type: "string", enum: ["skip", "scroll_down", "scroll_up", "fail"], description: "Fallback when element not found (for tap/find actions)" },
                repeat: {
                  type: "object",
                  properties: {
                    times: { type: "number", description: "Repeat N times (max 10)" },
                    until_found: { type: "string", description: "Repeat until element with this text appears" },
                    until_not_found: { type: "string", description: "Repeat until element with this text disappears" },
                  },
                  description: "Loop control",
                },
                on_error: { type: "string", enum: ["stop", "skip", "retry"], description: "Error handling (default: stop)" },
                label: { type: "string", description: "Label for logging" },
              },
              required: ["action"],
            },
            description: "Steps to execute sequentially",
          },
          maxDuration: { type: "number", description: "Max total duration in ms (default: 30000, max: 60000)", default: 30000 },
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "Target platform. If not specified, uses the active target." },
        },
        required: ["steps"],
      },
    },
    handler: async (args, ctx, _depth = 0) => {
      if (_depth! > MAX_RECURSION_DEPTH) {
        throw new Error(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded. Nested batch_commands/run_flow calls are limited to prevent stack overflow.`);
      }

      const platform = args.platform as Platform | undefined;
      const steps = args.steps as FlowStep[];
      const maxDuration = Math.min((args.maxDuration as number) ?? 30000, FLOW_MAX_DURATION);
      const currentPlatform = (platform ?? ctx.deviceManager.getCurrentPlatform()) as string;

      if (!steps || steps.length === 0) {
        throw new ValidationError("No steps provided.");
      }
      if (steps.length > FLOW_MAX_STEPS) {
        throw new ValidationError(`Too many steps (${steps.length}). Maximum is ${FLOW_MAX_STEPS}.`);
      }

      // Validate all actions are allowed
      for (const step of steps) {
        if (!isFlowActionAllowed(step.action)) {
          throw new MobileError(
            `Action "${step.action}" is not allowed in flows. Use only safe actions.`,
            "FLOW_SECURITY"
          );
        }
      }

      const flowStart = Date.now();
      const results: FlowStepResult[] = [];

      for (let i = 0; i < steps.length; i++) {
        if (Date.now() - flowStart > maxDuration) {
          results.push({
            step: i + 1,
            action: steps[i].action,
            label: steps[i].label,
            success: false,
            message: `Flow timeout (${maxDuration}ms exceeded)`,
            durationMs: 0,
          });
          break;
        }

        const step = steps[i];
        const stepArgs = { platform: currentPlatform, ...step.args } as Record<string, unknown>;
        const onError = step.on_error ?? "stop";

        const repeatTimes = step.repeat?.times ? Math.min(step.repeat.times, FLOW_MAX_REPEAT) : 1;
        const untilFound = step.repeat?.until_found;
        const untilNotFound = step.repeat?.until_not_found;
        const hasRepeatCondition = untilFound || untilNotFound;
        const maxIterations = hasRepeatCondition ? FLOW_MAX_REPEAT : repeatTimes;

        let lastStepResult: FlowStepResult | null = null;

        for (let iter = 0; iter < maxIterations; iter++) {
          if (Date.now() - flowStart > maxDuration) break;

          const stepStart = Date.now();

          try {
            const result = await ctx.handleTool(step.action, stepArgs, (_depth ?? 0) + 1);
            const text = typeof result === "object" && result !== null && "text" in result
              ? (result as { text: string }).text
              : JSON.stringify(result);

            lastStepResult = {
              step: i + 1,
              action: step.action,
              label: step.label,
              success: true,
              message: text.slice(0, 200),
              durationMs: Date.now() - stepStart,
            };

            if (hasRepeatCondition) {
              try {
                const elements = await ctx.getElementsForPlatform(currentPlatform);
                if (untilFound) {
                  const found = findElements(elements, { text: untilFound });
                  if (found.length > 0) break;
                }
                if (untilNotFound) {
                  const found = findElements(elements, { text: untilNotFound });
                  if (found.length === 0) break;
                }
              } catch (condErr: unknown) {
                if (condErr instanceof DeviceNotFoundError || condErr instanceof DeviceOfflineError || condErr instanceof AdbNotInstalledError) {
                  throw condErr;
                }
              }
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch (error: unknown) {
            const durationMs = Date.now() - stepStart;
            const errorMessage = error instanceof Error ? error.message : String(error);
            const isNotFound = errorMessage.includes("not found") || errorMessage.includes("No element");

            if (isNotFound && step.if_not_found) {
              if (step.if_not_found === "skip") {
                lastStepResult = {
                  step: i + 1, action: step.action, label: step.label,
                  success: true, message: `Skipped (element not found)`, durationMs,
                };
                break;
              } else if (step.if_not_found === "scroll_down" || step.if_not_found === "scroll_up") {
                try {
                  await ctx.handleTool("swipe", { direction: step.if_not_found === "scroll_down" ? "up" : "down", platform: currentPlatform }, (_depth ?? 0) + 1);
                  await new Promise(resolve => setTimeout(resolve, 300));
                  const retryResult = await ctx.handleTool(step.action, stepArgs, (_depth ?? 0) + 1);
                  const retryText = typeof retryResult === "object" && retryResult !== null && "text" in retryResult
                    ? (retryResult as { text: string }).text
                    : JSON.stringify(retryResult);
                  lastStepResult = {
                    step: i + 1, action: step.action, label: step.label,
                    success: true, message: `${retryText.slice(0, 150)} (after ${step.if_not_found})`,
                    durationMs: Date.now() - stepStart,
                  };
                  break;
                } catch (retryErr: unknown) {
                  const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  lastStepResult = {
                    step: i + 1, action: step.action, label: step.label,
                    success: false, message: `${retryMsg} (after ${step.if_not_found})`,
                    durationMs: Date.now() - stepStart,
                  };
                  if (onError === "stop") break;
                  if (onError === "skip") break;
                }
              } else {
                lastStepResult = {
                  step: i + 1, action: step.action, label: step.label,
                  success: false, message: errorMessage, durationMs,
                };
              }
              break;
            }

            if (onError === "retry" && iter < maxIterations - 1) {
              await new Promise(resolve => setTimeout(resolve, 300));
              if (Date.now() - flowStart > maxDuration) break;
              continue;
            }

            lastStepResult = {
              step: i + 1, action: step.action, label: step.label,
              success: false, message: errorMessage, durationMs,
            };

            if (onError === "stop") {
              results.push(lastStepResult);
              const diag = await collectFailureDiag(ctx, currentPlatform, i + 1);
              return { text: formatFlowResults(results, Date.now() - flowStart, diag) };
            }
            break;
          }
        }

        if (lastStepResult) {
          results.push(lastStepResult);
          if (!lastStepResult.success && (step.on_error ?? "stop") === "stop") {
            const diag = await collectFailureDiag(ctx, currentPlatform, i + 1);
            return { text: formatFlowResults(results, Date.now() - flowStart, diag) };
          }
        }
      }

      const lastFailed = results.length > 0 && !results[results.length - 1].success;
      const diag = lastFailed ? await collectFailureDiag(ctx, currentPlatform, results.length) : "";
      return { text: formatFlowResults(results, Date.now() - flowStart, diag) };
    },
  },
  {
    tool: {
      name: "flow_parallel",
      description: "Run same action on multiple devices in parallel. Uses Promise.allSettled for concurrent execution.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", description: "Tool name to execute on each device" },
          args: { type: "object", description: "Arguments for the action (deviceId will be injected per device)" },
          devices: {
            type: "array",
            items: { type: "string" },
            description: "Array of device IDs to target. Use device(action:'list') to get available devices.",
          },
        },
        required: ["action", "devices"],
      },
    },
    handler: async (args, ctx, _depth = 0) => {
      if (_depth! > MAX_RECURSION_DEPTH) {
        throw new Error(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded. Nested flow calls are limited to prevent stack overflow.`);
      }

      const action = args.action as string;
      const actionArgs = (args.args ?? {}) as Record<string, unknown>;
      const devices = args.devices as string[];

      if (!devices || devices.length === 0) {
        throw new ValidationError("No devices specified.");
      }

      if (devices.length > PARALLEL_MAX_DEVICES) {
        throw new ValidationError(`Too many devices (${devices.length}). Maximum is ${PARALLEL_MAX_DEVICES}.`);
      }

      if (!isFlowActionAllowed(action)) {
        throw new MobileError(
          `Action "${action}" is not allowed in parallel flows. Use only safe actions.`,
          "FLOW_SECURITY"
        );
      }

      // Run on each device by injecting deviceId into args.
      // This avoids mutating the shared global device state which would
      // cause race conditions with concurrent Promise.allSettled execution.
      const results = await Promise.allSettled(
        devices.map(async (deviceId) => {
          const result = await ctx.handleTool(action, { ...actionArgs, deviceId }, (_depth ?? 0) + 1);
          return { deviceId, result };
        })
      );

      const lines: string[] = [`Parallel: ${action} on ${devices.length} devices`];

      for (const r of results) {
        if (r.status === "fulfilled") {
          const { deviceId, result } = r.value;
          const text = typeof result === "object" && result !== null && "text" in result
            ? (result as { text: string }).text
            : JSON.stringify(result);
          lines.push(`  ${deviceId}: OK — ${truncateOutput(text, { maxChars: 200, maxLines: 5 })}`);
        } else {
          lines.push(`  ???: FAIL — ${r.reason?.message ?? String(r.reason)}`);
        }
      }

      const failed = results.filter(r => r.status === "rejected").length;
      lines.push(`\n${devices.length - failed}/${devices.length} OK`);

      return { text: lines.join("\n") };
    },
  },
];
