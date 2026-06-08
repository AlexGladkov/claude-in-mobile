import { MAX_RECURSION_DEPTH } from "../context.js";
import { ValidationError, MobileError } from "../../errors.js";
import { truncateOutput } from "../../utils/truncate.js";
import { defineTool, z } from "../define-tool.js";
import { textResult } from "../../utils/tool-result.js";
import {
  BATCH_MAX_COMMANDS,
  ContentBlock,
  batchCommandSchema,
  captureTurboScreenshot,
  collectCompactUiTree,
  isFlowActionAllowed,
} from "./common.js";

export const flowBatch = defineTool({
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
});
