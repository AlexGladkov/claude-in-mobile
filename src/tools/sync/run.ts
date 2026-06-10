import { MAX_RECURSION_DEPTH } from "../context.js";
import { ValidationError, MobileError, SyncRoleNotFoundError } from "../../errors.js";
import { defineTool, z } from "../define-tool.js";
import { textResult } from "../../utils/tool-result.js";
import {
  SYNC_MAX_DURATION,
  SYNC_MAX_STEPS,
  SyncStep,
  executeSync,
  formatSyncResult,
  getGroup,
  isSyncActionAllowed,
  stepSchema,
  validateStepArgs,
} from "./common.js";

export const syncRun = defineTool({
  name: "sync_run",
  description: "Execute coordinated steps across devices with barrier synchronization.",
  schema: z.object({
    group: z.string().describe("Sync group name"),
    steps: z.array(stepSchema).describe("Sync steps with role targeting and barriers"),
    maxDuration: z.number().optional().describe("Max total duration ms (default: 60000)"),
  }),
  handler: async (args, ctx, depth = 0) => {
    if ((depth ?? 0) > MAX_RECURSION_DEPTH) {
      throw new MobileError(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded.`, "MAX_RECURSION");
    }

    const groupName = args.group;
    const steps = args.steps as SyncStep[];
    const maxDuration = Math.min(args.maxDuration || 60_000, SYNC_MAX_DURATION);

    const group = getGroup(groupName);

    if (!steps || steps.length === 0) {
      throw new ValidationError("No steps provided.");
    }

    if (steps.length > SYNC_MAX_STEPS) {
      throw new ValidationError(`Too many steps (${steps.length}). Maximum is ${SYNC_MAX_STEPS}.`);
    }

    // Validate each step
    for (const step of steps) {
      if (!group.roles.find(r => r.name === step.role)) {
        throw new SyncRoleNotFoundError(step.role, group.name);
      }

      if (!isSyncActionAllowed(step.action)) {
        throw new MobileError(
          `Action "${step.action}" is not allowed in sync execution.`,
          "SYNC_SECURITY"
        );
      }

      if (step.args) {
        validateStepArgs(step.args);
      }
    }

    const result = await executeSync(group, steps, ctx, depth ?? 0, maxDuration);
    return textResult(formatSyncResult(result, group));
  },
});
