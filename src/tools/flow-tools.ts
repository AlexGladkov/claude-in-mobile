import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { findElements } from "../adb/ui-parser.js";
import { DeviceNotFoundError, DeviceOfflineError, AdbNotInstalledError } from "../errors.js";
import { MAX_RECURSION_DEPTH } from "./context.js";

// Flow Engine constants
const FLOW_ALLOWED_ACTIONS = new Set([
  "tap", "double_tap", "swipe", "input_text", "press_key", "wait", "wait_for_element",
  "screenshot", "analyze_screen", "assert_visible", "assert_not_exists",
  "find_and_tap", "find_element", "open_url",
  "select_text", "copy_text", "paste_text",
  "browser_click", "browser_fill", "browser_snapshot", "browser_screenshot",
  "browser_navigate", "browser_press_key", "browser_wait_for_selector",
  "browser_evaluate",
]);

const FLOW_MAX_STEPS = 20;
const BATCH_MAX_COMMANDS = 50;
const FLOW_MAX_DURATION = 60000;
const FLOW_MAX_REPEAT = 10;

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

function formatFlowResults(results: FlowStepResult[], totalMs: number): string {
  const lines: string[] = [`Flow completed (${totalMs}ms)`, ""];
  for (const r of results) {
    const label = r.label ? ` (${r.label})` : "";
    const status = r.success ? "OK" : "FAIL";
    lines.push(`${r.step}. ${r.action}${label}: ${status} — ${r.message} (${r.durationMs}ms)`);
  }
  return lines.join("\n");
}

export const flowTools: ToolDefinition[] = [
  {
    tool: {
      name: "batch_commands",
      description: "Execute multiple commands in a single MCP round-trip. Commands run sequentially on the server. 2-4x faster than individual tool calls for multi-step automation.",
      inputSchema: {
        type: "object",
        properties: {
          commands: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Tool name (e.g., 'tap', 'wait', 'input_text')" },
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
        return { text: "No commands provided" };
      }

      if (commands.length > BATCH_MAX_COMMANDS) {
        return { text: `Too many commands (${commands.length}). Maximum is ${BATCH_MAX_COMMANDS}.` };
      }

      const results: Array<{ command: string; success: boolean; result: string }> = [];

      for (const cmd of commands) {
        try {
          const result = await ctx.handleTool(cmd.name, cmd.arguments ?? {}, (_depth ?? 0) + 1);
          const text = typeof result === "object" && result !== null && "text" in result
            ? (result as { text: string }).text
            : JSON.stringify(result);

          results.push({ command: cmd.name, success: true, result: text });
        } catch (error: any) {
          results.push({ command: cmd.name, success: false, result: error.message });
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
      name: "run_flow",
      description: "Execute a multi-step automation flow in a single round-trip. Supports conditional logic (if_not_found), loops (repeat), and error handling (on_error). Much more efficient than individual tool calls for sequences. Max 20 steps, 60s timeout.",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                action: { type: "string", description: "Tool name: tap, swipe, input_text, press_key, wait, wait_for_element, screenshot, analyze_screen, assert_visible, assert_not_exists, find_and_tap, find_element, open_url" },
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
        return { text: "No steps provided" };
      }
      if (steps.length > FLOW_MAX_STEPS) {
        return { text: `Too many steps (${steps.length}). Maximum is ${FLOW_MAX_STEPS}.` };
      }

      // Validate all actions are allowed
      for (const step of steps) {
        if (!FLOW_ALLOWED_ACTIONS.has(step.action)) {
          return { text: `Action "${step.action}" is not allowed in flows. Allowed: ${[...FLOW_ALLOWED_ACTIONS].join(", ")}` };
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
              } catch (condErr: any) {
                if (condErr instanceof DeviceNotFoundError || condErr instanceof DeviceOfflineError || condErr instanceof AdbNotInstalledError) {
                  throw condErr;
                }
              }
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch (error: any) {
            const durationMs = Date.now() - stepStart;
            const isNotFound = error.message?.includes("not found") || error.message?.includes("No element");

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
                } catch (retryErr: any) {
                  lastStepResult = {
                    step: i + 1, action: step.action, label: step.label,
                    success: false, message: `${retryErr.message} (after ${step.if_not_found})`,
                    durationMs: Date.now() - stepStart,
                  };
                  if (onError === "stop") break;
                  if (onError === "skip") break;
                }
              } else {
                lastStepResult = {
                  step: i + 1, action: step.action, label: step.label,
                  success: false, message: error.message, durationMs,
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
              success: false, message: error.message, durationMs,
            };

            if (onError === "stop") {
              results.push(lastStepResult);
              return { text: formatFlowResults(results, Date.now() - flowStart) };
            }
            break;
          }
        }

        if (lastStepResult) {
          results.push(lastStepResult);
          if (!lastStepResult.success && (step.on_error ?? "stop") === "stop") {
            return { text: formatFlowResults(results, Date.now() - flowStart) };
          }
        }
      }

      return { text: formatFlowResults(results, Date.now() - flowStart) };
    },
  },
];
