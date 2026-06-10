import { MAX_RECURSION_DEPTH } from "../context.js";
import { MobileError } from "../../errors.js";
import { truncateOutput } from "../../utils/truncate.js";
import { defineTool, z } from "../define-tool.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import { sleep } from "../../utils/sleep.js";
import {
  SYNC_ASSERT_DEFAULT_DELAY,
  SYNC_ASSERT_MAX_RETRIES,
  SYNC_ASSERT_RETRY_DELAY,
  getDeviceIdForRole,
  getGroup,
  isSyncActionAllowed,
  validateStepArgs,
} from "./common.js";

export const syncAssertCross = defineTool({
  name: "sync_assert_cross",
  description: "Cross-device assertion: perform action on source device, verify result on target device with retries.",
  schema: z.object({
    group: z.string().describe("Sync group name"),
    source_role: z.string().describe("Role that performs the source action"),
    source_action: z.string().describe("Action to execute on source device"),
    source_args: z.record(z.string(), z.unknown()).optional().describe("Source action arguments"),
    target_role: z.string().describe("Role that verifies the result"),
    target_action: z.string().describe("Assertion action on target device"),
    target_args: z.record(z.string(), z.unknown()).optional().describe("Target action arguments"),
    delay_ms: z.number().optional().describe("Delay between source and target (default: 1000)"),
    retries: z.number().optional().describe("Max target assertion retries (default: 3)"),
    label: z.string().optional().describe("Assertion label"),
  }),
  handler: async (args, ctx, depth = 0) => {
    if ((depth ?? 0) > MAX_RECURSION_DEPTH) {
      throw new MobileError(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded.`, "MAX_RECURSION");
    }

    const groupName = args.group;
    const sourceRole = args.source_role;
    const sourceAction = args.source_action;
    const sourceArgs = (args.source_args ?? {}) as Record<string, unknown>;
    const targetRole = args.target_role;
    const targetAction = args.target_action;
    const targetArgs = (args.target_args ?? {}) as Record<string, unknown>;
    const delayMs = Math.min(args.delay_ms || SYNC_ASSERT_DEFAULT_DELAY, 30_000);
    const retries = Math.min(args.retries || 3, SYNC_ASSERT_MAX_RETRIES);
    const label = args.label || `${sourceAction} → ${targetAction}`;

    const group = getGroup(groupName);
    const sourceDeviceId = getDeviceIdForRole(group, sourceRole);
    const targetDeviceId = getDeviceIdForRole(group, targetRole);

    // Validate actions
    for (const action of [sourceAction, targetAction]) {
      if (!isSyncActionAllowed(action)) {
        throw new MobileError(`Action "${action}" is not allowed in sync.`, "SYNC_SECURITY");
      }
    }

    if (sourceArgs) validateStepArgs(sourceArgs);
    if (targetArgs) validateStepArgs(targetArgs);

    const totalStart = Date.now();

    // Execute source action
    const sourceStart = Date.now();
    let sourceText: string;
    try {
      const result = await ctx.handleTool(
        sourceAction,
        { ...sourceArgs, deviceId: sourceDeviceId },
        (depth ?? 0) + 1,
      );
      sourceText = typeof result === "object" && result !== null && "text" in result
        ? (result as { text: string }).text
        : JSON.stringify(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return errorResult(
        `Cross-assert FAILED (${label})\n  source [${sourceRole}]: ${sourceAction} FAIL — ${msg} (${Date.now() - sourceStart}ms)`,
      );
    }
    const sourceMs = Date.now() - sourceStart;

    // Delay
    await sleep(delayMs);

    // Target assertion with retries
    let lastError = "";
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await ctx.handleTool(
          targetAction,
          { ...targetArgs, deviceId: targetDeviceId },
          (depth ?? 0) + 1,
        );
        const targetText = typeof result === "object" && result !== null && "text" in result
          ? (result as { text: string }).text
          : JSON.stringify(result);

        const totalMs = Date.now() - totalStart;
        return textResult(
          [
            `Cross-assert PASSED (${label}) — ${totalMs}ms`,
            `  source [${sourceRole}]: ${sourceAction} OK — ${truncateOutput(sourceText, { maxChars: 150, maxLines: 2 })} (${sourceMs}ms)`,
            `  delay: ${delayMs}ms`,
            `  target [${targetRole}]: ${targetAction} OK — ${truncateOutput(targetText, { maxChars: 150, maxLines: 2 })} (attempt ${attempt}/${retries})`,
          ].join("\n"),
        );
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < retries) {
          await sleep(SYNC_ASSERT_RETRY_DELAY);
        }
      }
    }

    const totalMs = Date.now() - totalStart;
    return errorResult(
      [
        `Cross-assert FAILED (${label}) — ${totalMs}ms`,
        `  source [${sourceRole}]: ${sourceAction} OK — ${truncateOutput(sourceText, { maxChars: 150, maxLines: 2 })} (${sourceMs}ms)`,
        `  delay: ${delayMs}ms`,
        `  target [${targetRole}]: ${targetAction} FAIL after ${retries} retries — ${lastError}`,
      ].join("\n"),
    );
  },
});
