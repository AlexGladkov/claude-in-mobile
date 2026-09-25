import { MAX_RECURSION_DEPTH } from "../context.js";
import { ValidationError, MobileError } from "../../errors.js";
import { defineTool, z } from "../define-tool.js";
import { textResult } from "../../utils/tool-result.js";
import {
  BATCH_MAX_COMMANDS,
  ContentBlock,
  FlowTimeoutError,
  FLOW_MAX_DURATION,
  batchCommandSchema,
  captureTurboScreenshot,
  collectCompactUiTree,
  isFlowActionAllowed,
  platformEnum,
  linkFlowAbortController,
  runWithDeadline,
} from "./common.js";
import { deviceIdField } from "../common-schema.js";

export const flowBatch = defineTool({
  name: "flow_batch",
  description: "Execute multiple commands in one round-trip. Set turbo:true for UI context per step (experimental). Cancellation and time budgets are cooperative; non-cancellable operations may overrun or finish after cancellation.",
  schema: z.object({
    commands: z
      .array(batchCommandSchema)
      .optional()
      .describe("Array of commands to execute sequentially"),
    platform: platformEnum,
    deviceId: deviceIdField,
    stopOnError: z.boolean().optional().describe("Stop execution on first error (default: true)"),
    maxDuration: z.number().finite().min(1).max(FLOW_MAX_DURATION).optional()
      .describe("Orchestration time budget in ms (default: 30000, max: 60000). Cancellation is cooperative; non-cancellable operations may overrun this budget or finish after timeout."),
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
    const batchPlatform = args.platform as string | undefined;
    const batchDeviceId = args.deviceId as string | undefined;
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
      if (!isFlowActionAllowed(cmd.name, cmd.arguments ?? {})) {
        throw new MobileError(
          `Action "${cmd.name}" is not allowed in flow_batch. Use only safe actions.`,
          "FLOW_SECURITY"
        );
      }
    }

    const maxDuration = Math.min(args.maxDuration ?? 30_000, FLOW_MAX_DURATION);
    const batchStart = Date.now();
    const batchController = new AbortController();
    const unlinkParentSignal = linkFlowAbortController(ctx.signal, batchController);
    const batchSignal = batchController.signal;
    try {
    let timedOut = false;
    const remainingMs = (): number => Math.max(0, maxDuration - (Date.now() - batchStart));
    const abortBatch = (): void => {
      timedOut = true;
      if (!batchController.signal.aborted) batchController.abort();
    };


    const results: Array<{ command: string; success: boolean; result: string }> = [];
    // Turbo state
    const turboUiLines: string[] = [];
    const turboScreenshots: Array<{ data: string; mimeType: string }> = [];
    const TURBO_MAX_SCREENSHOTS = 5;

    for (let i = 0; i < commands.length; i++) {
      if (ctx.signal?.aborted) break;
      const cmd = commands[i];
      let success = true;
      let resultText = "";
      const cmdArgs = { ...(cmd.arguments ?? {}) };
      if (batchPlatform !== undefined && cmdArgs.platform === undefined) {
        cmdArgs.platform = batchPlatform;
      }
      if (batchDeviceId !== undefined && cmdArgs.deviceId === undefined) {
        cmdArgs.deviceId = batchDeviceId;
      }
      const commandPlatform =
        typeof cmdArgs.platform === "string"
          ? cmdArgs.platform
          : (ctx.deviceManager.getCurrentPlatform() as string);
      const commandDeviceId = typeof cmdArgs.deviceId === "string" ? cmdArgs.deviceId : undefined;
      if (turbo && !("hints" in cmdArgs)) {
        cmdArgs.hints = false; // turbo collects UI tree itself, skip redundant hints
      }
      try {

        await runWithDeadline(
          () => ctx.handleTool(
            cmd.name,
            cmdArgs,
            (_depth ?? 0) + 1,
            batchSignal,
          ),
          remainingMs(),
          abortBatch,
          batchSignal,
        );
        if (timedOut || remainingMs() <= 0) {
          abortBatch();
          throw new FlowTimeoutError();
        }
        if (ctx.signal?.aborted) {
          success = false;
          resultText = "Cancelled";
          results.push({ command: cmd.name, success, result: resultText });
          break;
        }

        resultText = "OK";
        results.push({ command: cmd.name, success: true, result: resultText });
      } catch (error: unknown) {
        success = false;
        const deadlineExpired =
          error instanceof FlowTimeoutError || timedOut || remainingMs() <= 0;
        const cancelled = ctx.signal?.aborted === true && !timedOut && !deadlineExpired;
        if (deadlineExpired) abortBatch();
        resultText = deadlineExpired
          ? "Max duration exceeded"
          : cancelled
            ? "Cancelled"
            : "Action failed";
        results.push({ command: cmd.name, success: false, result: resultText });
      }

      // Turbo: collect UI tree after each step, screenshot on failure
      if (turbo && !timedOut && !ctx.signal?.aborted) {
        try {
          const uiTree = await runWithDeadline(
            () => collectCompactUiTree(ctx, commandPlatform, commandDeviceId, batchSignal),
            remainingMs(),
            abortBatch,
            batchSignal,
          );
          if (uiTree) {
            turboUiLines.push(`   [UI] ${uiTree}`);
          } else {
            turboUiLines.push("");
          }
        } catch {
          turboUiLines.push("");
        }

        if (!success && turboScreenshots.length < TURBO_MAX_SCREENSHOTS) {
          try {
            const screenshot = await runWithDeadline(
              () => captureTurboScreenshot(
                ctx,
                commandPlatform,
                commandDeviceId,
                batchSignal,
                remainingMs(),
                _depth ?? 0,
              ),
              remainingMs(),
              abortBatch,
              batchSignal,
            );
            if (screenshot) {
              turboScreenshots.push(screenshot);
              const lineIndex = turboUiLines.length - 1;
              if (lineIndex < 0) {
                turboUiLines.push("   [screenshot attached]");
              } else {
                const uiLine = turboUiLines[lineIndex];
                turboUiLines[lineIndex] = uiLine
                  ? `${uiLine}\n   [screenshot attached]`
                  : "   [screenshot attached]";
              }
            }
          } catch {
            // Diagnostics must not mask the action failure or exceed the deadline.
          }
        }
      }
      if (timedOut || ctx.signal?.aborted) break;

      if (!success && stopOnError) {
        break;
      }
    }

    const failed = results.filter(r => !r.success).length;
    const cancelled = ctx.signal?.aborted === true && !timedOut;
    const summary = timedOut
      ? `Batch incomplete (max duration exceeded): ${results.length}/${commands.length} executed, ${failed} failed`
      : cancelled
        ? `Batch cancelled: ${results.length}/${commands.length} executed, ${failed} failed`
        : failed > 0
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
    } finally {
      unlinkParentSignal();
    }
  },
});
