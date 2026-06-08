import type { ToolDefinition } from "./registry.js";
import { getRegisteredToolNames } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { Platform } from "../device-manager.js";
import { parseUiHierarchy, findElements, UiElement } from "../adb/ui-parser.js";
import { DeviceNotFoundError, DeviceOfflineError, AdbNotInstalledError, ValidationError, MobileError } from "../errors.js";
import { MAX_RECURSION_DEPTH } from "./context.js";
import { truncateOutput } from "../utils/truncate.js";
import { applyScale } from "./helpers/resolve-element.js";
import { defineTool, z } from "./define-tool.js";
import { textResult } from "../utils/tool-result.js";
import { sleep } from "../utils/sleep.js";
import { FLOW } from "../constants/timeouts.js";

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

const FLOW_MAX_STEPS = FLOW.MAX_STEPS;
const BATCH_MAX_COMMANDS = 50;
const FLOW_MAX_DURATION = FLOW.MAX_DURATION_MS;
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

/** ContentBlock for turbo multi-content responses */
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Collect compact UI tree: interactive elements, no passwords, redacted input text.
 * Returns pipe-separated one-liner like: Button "Login" | EditText [input] | TextView "Welcome"
 */
async function collectCompactUiTree(
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

/** Actions eligible for fast-track (canonical + common aliases) */
const FAST_TRACK_TAP = new Set(["input_tap", "tap", "click"]);
const FAST_TRACK_KEY = new Set(["input_key", "press_key", "press_button"]);
const FAST_TRACK_TEXT = new Set(["input_text", "type_text", "type"]);

/** Shell-escape text for ADB input (mirrors AdbClient.inputText logic) */
function escapeAdbText(text: string): string {
  return text
    .replace(/[\n\r]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$")
    .replace(/ /g, "%s")
    .replace(/&/g, "\\&")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/\|/g, "\\|")
    .replace(/;/g, "\\;");
}

interface FastTrackResult {
  message: string;
  uiCompact: string;
}

/**
 * Try to execute a step via fast-track (1 ADB call for action + UI dump).
 * Returns null if the step can't be fast-tracked → caller falls through to handleTool.
 */
async function turboFastTrack(
  step: FlowStep,
  ctx: ToolContext,
  platform: string,
  deviceId?: string,
): Promise<FastTrackResult | null> {
  if (platform !== "android") return null;

  const action = step.action;
  const args = step.args ?? {};
  let shellCmd: string | null = null;
  let message = "";

  // input_tap — only raw x/y (no element resolution)
  if (FAST_TRACK_TAP.has(action)
      && typeof args.x === "number" && typeof args.y === "number"
      && !args.text && !args.resourceId && !args.index && !args.label) {
    const scaled = applyScale(args.x as number, args.y as number, platform, ctx);
    shellCmd = `input tap ${scaled.x} ${scaled.y}`;
    message = `Tapped at (${scaled.x}, ${scaled.y})`;
  }

  // input_key
  else if (FAST_TRACK_KEY.has(action) && args.key) {
    const key = (args.key as string).toUpperCase();
    const code = FAST_TRACK_KEYS[key] ?? parseInt(key);
    if (isNaN(code)) return null;
    shellCmd = `input keyevent ${code}`;
    message = `Pressed key: ${key}`;
  }

  // input_text
  else if (FAST_TRACK_TEXT.has(action) && args.text) {
    const escaped = escapeAdbText(args.text as string);
    shellCmd = `input text "${escaped}"`;
    message = `Entered text: "${(args.text as string).slice(0, 50)}"`;
  }

  if (!shellCmd) return null;

  try {
    const adb = ctx.deviceManager.getAndroidClient(deviceId);
    const { uiXml } = await adb.execWithUiDump(shellCmd);

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
async function collectFailureDiag(
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
async function captureTurboScreenshot(
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

interface TurboStepContext {
  uiTree?: string;
  hasScreenshot?: boolean;
}

function formatFlowResults(
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
const platformEnum = z
  .enum(["android", "ios", "desktop", "aurora", "browser"])
  .optional()
  .describe("Target platform. If not specified, uses the active target.");

const batchCommandSchema = z.object({
  name: z.string().describe("Tool name (e.g., 'input_tap', 'system_wait', 'input_text')"),
  arguments: z.record(z.string(), z.unknown()).optional().describe("Tool arguments"),
});

const flowStepSchema = z.object({
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

export const flowTools: ToolDefinition[] = [
  defineTool({
    name: "flow_batch",
    description: "Execute multiple commands in one round-trip. Set turbo:true for UI context per step (experimental).",
    schema: z.object({
      commands: z
        .array(batchCommandSchema)
        .optional()
        .describe("Array of commands to execute sequentially"),
      stopOnError: z.boolean().optional().describe("Stop execution on first error (default: true)"),
      turbo: z
        .boolean()
        .optional()
        .describe("[experimental] Rich UI feedback per step. Compact UI tree after each step, screenshot on failure."),
    }),
    handler: async (args, ctx, _depth = 0) => {
      if ((_depth ?? 0) > MAX_RECURSION_DEPTH) {
        throw new Error(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded. Nested batch_commands/run_flow calls are limited to prevent stack overflow.`);
      }

      const commands = args.commands as Array<{ name: string; arguments?: Record<string, unknown> }> | undefined;
      const stopOnError = args.stopOnError !== false;
      const turbo = args.turbo ?? ctx.turboDefault;

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
      // Turbo state
      const turboUiLines: string[] = [];
      const turboScreenshots: Array<{ data: string; mimeType: string }> = [];
      const TURBO_MAX_SCREENSHOTS = 5;
      // Detect platform for turbo UI collection
      const turboPlatform = turbo ? (ctx.deviceManager.getCurrentPlatform() as string) : "";

      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        let success = true;
        let resultText = "";

        try {
          const cmdArgs = { ...(cmd.arguments ?? {}) };
          if (turbo && !("hints" in cmdArgs)) {
            cmdArgs.hints = false; // turbo collects UI tree itself, skip redundant hints
          }
          const result = await ctx.handleTool(cmd.name, cmdArgs, (_depth ?? 0) + 1);
          const text = typeof result === "object" && result !== null && "text" in result
            ? (result as { text: string }).text
            : JSON.stringify(result);

          resultText = truncateOutput(text, { maxChars: 500, maxLines: 20 });
          results.push({ command: cmd.name, success: true, result: resultText });
        } catch (error: unknown) {
          success = false;
          const msg = error instanceof Error ? error.message : String(error);
          resultText = msg;
          results.push({ command: cmd.name, success: false, result: msg });
        }

        // Turbo: collect UI tree after each step, screenshot on failure
        if (turbo) {
          try {
            const uiTree = await collectCompactUiTree(ctx, turboPlatform);
            if (uiTree) {
              turboUiLines.push(`   [UI] ${uiTree}`);
            } else {
              turboUiLines.push("");
            }
          } catch {
            turboUiLines.push("");
          }

          if (!success && turboScreenshots.length < TURBO_MAX_SCREENSHOTS) {
            const screenshot = await captureTurboScreenshot(ctx, turboPlatform);
            if (screenshot) turboScreenshots.push(screenshot);
            // Mark this line for screenshot reference
            if (turboUiLines.length > 0 && turboUiLines[turboUiLines.length - 1] !== "") {
              turboUiLines[turboUiLines.length - 1] += "\n   [screenshot attached]";
            } else {
              turboUiLines.push("   [screenshot attached]");
            }
          }
        }

        if (!success && stopOnError) {
          break;
        }
      }

      const failed = results.filter(r => !r.success).length;
      const summary = failed > 0
        ? `Batch: ${results.length}/${commands.length} executed, ${failed} failed`
        : `Batch: ${results.length} commands OK`;

      const outputLines = results.map((r, i) => {
        let line = `${i + 1}. ${r.command}: ${r.success ? "OK" : "ERROR"} — ${r.result}`;
        if (turbo && turboUiLines[i]) {
          line += `\n${turboUiLines[i]}`;
        }
        return line;
      });

      const textBlock = `${summary}\n\n${outputLines.join("\n")}`;

      // Turbo: return multi-content with screenshots
      if (turbo && turboScreenshots.length > 0) {
        const content: ContentBlock[] = [{ type: "text", text: textBlock }];
        for (const ss of turboScreenshots) {
          content.push({ type: "image", data: ss.data, mimeType: ss.mimeType });
        }
        // Multi-content (text+image) escape hatch — cast through unknown because
        // the canonical ToolResult shape only allows text blocks. Image responses
        // are valid MCP content but live outside the strict text-only type.
        return { content, text: textBlock } as unknown as ReturnType<typeof textResult>;
      }

      return textResult(textBlock);
    },
  }),
  defineTool({
    name: "flow_run",
    description: "Multi-step automation flow with conditionals, loops, error handling. Use for E2E testing instead of calling tools one-by-one. Set turbo:true for UI context per step (experimental). Max 20 steps.",
    schema: z.object({
      steps: z.array(flowStepSchema).optional().describe("Steps to execute sequentially"),
      maxDuration: z.number().optional().describe("Max total duration in ms (default: 30000, max: 60000)"),
      platform: platformEnum,
      turbo: z
        .boolean()
        .optional()
        .describe("[experimental] Rich UI feedback per step. Compact UI tree after each step, screenshot on failure."),
    }),
    handler: async (args, ctx, _depth = 0) => {
      if ((_depth ?? 0) > MAX_RECURSION_DEPTH) {
        throw new Error(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded. Nested batch_commands/run_flow calls are limited to prevent stack overflow.`);
      }

      const platform = args.platform as Platform | undefined;
      const steps = args.steps as FlowStep[] | undefined;
      const maxDuration = Math.min((args.maxDuration as number) ?? 30000, FLOW_MAX_DURATION);
      const currentPlatform = (platform ?? ctx.deviceManager.getCurrentPlatform()) as string;
      const turbo = args.turbo ?? ctx.turboDefault;

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

      // Turbo state
      const turboContexts = turbo ? new Map<number, TurboStepContext>() : undefined;
      const turboScreenshots: Array<{ data: string; mimeType: string }> = [];
      const TURBO_MAX_SCREENSHOTS = 5;

      /** Collect turbo context for a step. Time spent here does NOT count against maxDuration. */
      async function collectTurboContext(stepNum: number, stepSuccess: boolean): Promise<void> {
        if (!turbo || !turboContexts) return;
        if (turboContexts.has(stepNum)) return; // Already populated by fast-track
        const ctx_entry: TurboStepContext = {};

        if (!stepSuccess && turboScreenshots.length < TURBO_MAX_SCREENSHOTS) {
          // Parallel: UI tree + screenshot simultaneously on failure
          const [uiTree, screenshot] = await Promise.all([
            collectCompactUiTree(ctx, currentPlatform).catch(() => ""),
            captureTurboScreenshot(ctx, currentPlatform),
          ]);
          if (uiTree) ctx_entry.uiTree = uiTree;
          if (screenshot) {
            turboScreenshots.push(screenshot);
            ctx_entry.hasScreenshot = true;
          }
        } else {
          // Success: only UI tree (no screenshot needed)
          try {
            const uiTree = await collectCompactUiTree(ctx, currentPlatform);
            if (uiTree) ctx_entry.uiTree = uiTree;
          } catch { /* silently skip */ }
        }

        turboContexts.set(stepNum, ctx_entry);
      }

      /** Build the final return value, factoring in turbo multi-content. */
      function buildReturn(totalMs: number, diagBlock: string = "") {
        const text = formatFlowResults(results, totalMs, diagBlock, turboContexts);
        if (turbo && turboScreenshots.length > 0) {
          const content: ContentBlock[] = [{ type: "text", text }];
          for (const ss of turboScreenshots) {
            content.push({ type: "image", data: ss.data, mimeType: ss.mimeType });
          }
          // See note in flow_batch — multi-content (text+image) requires casting
          // because ToolResult is text-only in the canonical typing.
          return { content, text } as unknown as ReturnType<typeof textResult>;
        }
        return textResult(text);
      }

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
        if (turbo && !("hints" in stepArgs)) {
          stepArgs.hints = false; // turbo collects UI tree itself via collectCompactUiTree, skip redundant hints
        }
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

          // Turbo fast-track: combine action + UI dump in 1 ADB call (~150-300ms saved per step)
          // Only for simple Android actions without repeat/if_not_found
          if (turbo && !hasRepeatCondition && repeatTimes === 1 && !step.if_not_found) {
            const fastResult = await turboFastTrack(step, ctx, currentPlatform, stepArgs.deviceId as string | undefined);
            if (fastResult) {
              lastStepResult = {
                step: i + 1, action: step.action, label: step.label,
                success: true, message: fastResult.message.slice(0, 200),
                durationMs: Date.now() - stepStart,
              };
              if (turboContexts) {
                turboContexts.set(i + 1, { uiTree: fastResult.uiCompact });
              }
              break; // Exit repeat loop — fast-track always single iteration
            }
          }

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
              await sleep(turbo ? FLOW.STEP_DELAY_TURBO_MS : FLOW.STEP_DELAY_NORMAL_MS);
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
                  await sleep(turbo ? FLOW.STEP_DELAY_TURBO_MS : FLOW.STEP_DELAY_NORMAL_MS);
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
              await sleep(turbo ? FLOW.STEP_DELAY_TURBO_MS : FLOW.STEP_DELAY_NORMAL_MS);
              if (Date.now() - flowStart > maxDuration) break;
              continue;
            }

            lastStepResult = {
              step: i + 1, action: step.action, label: step.label,
              success: false, message: errorMessage, durationMs,
            };

            if (onError === "stop") {
              results.push(lastStepResult);
              // Turbo context collected outside maxDuration timer
              await collectTurboContext(i + 1, false);
              if (!turbo) {
                const diag = await collectFailureDiag(ctx, currentPlatform, i + 1);
                return textResult(formatFlowResults(results, Date.now() - flowStart, diag));
              }
              return buildReturn(Date.now() - flowStart);
            }
            break;
          }
        }

        if (lastStepResult) {
          results.push(lastStepResult);
          // Turbo: collect UI context after each step (outside maxDuration timer)
          await collectTurboContext(lastStepResult.step, lastStepResult.success);

          if (!lastStepResult.success && (step.on_error ?? "stop") === "stop") {
            if (!turbo) {
              const diag = await collectFailureDiag(ctx, currentPlatform, i + 1);
              return textResult(formatFlowResults(results, Date.now() - flowStart, diag));
            }
            return buildReturn(Date.now() - flowStart);
          }
        }
      }

      if (!turbo) {
        const lastFailed = results.length > 0 && !results[results.length - 1].success;
        const diag = lastFailed ? await collectFailureDiag(ctx, currentPlatform, results.length) : "";
        return textResult(formatFlowResults(results, Date.now() - flowStart, diag));
      }
      return buildReturn(Date.now() - flowStart);
    },
  }),
  defineTool({
    name: "flow_parallel",
    description: "Run same action on multiple devices in parallel. Uses Promise.allSettled for concurrent execution.",
    schema: z.object({
      action: z.string().describe("Tool name to execute on each device"),
      args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the action (deviceId will be injected per device)"),
      devices: z
        .array(z.string())
        .optional()
        .describe("Array of device IDs to target. Use device(action:'list') to get available devices."),
    }),
    handler: async (args, ctx, _depth = 0) => {
      if ((_depth ?? 0) > MAX_RECURSION_DEPTH) {
        throw new Error(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded. Nested flow calls are limited to prevent stack overflow.`);
      }

      const action = args.action;
      const actionArgs = (args.args ?? {}) as Record<string, unknown>;
      const devices = args.devices as string[] | undefined;

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

      return textResult(lines.join("\n"));
    },
  }),
];
