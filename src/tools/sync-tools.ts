import type { ToolDefinition } from "./registry.js";
import { getRegisteredToolNames } from "./registry.js";
import type { ToolContext } from "./context.js";
import { MAX_RECURSION_DEPTH } from "./context.js";
import {
  ValidationError,
  MobileError,
  SyncGroupNotFoundError,
  SyncGroupExistsError,
  SyncBarrierTimeoutError,
  SyncRoleNotFoundError,
} from "../errors.js";
import { validateBaselineName } from "../utils/sanitize.js";
import { validateDeviceId } from "../utils/sanitize.js";
import { truncateOutput } from "../utils/truncate.js";

// ── Types ──

interface SyncGroupRole {
  name: string;
  deviceId: string;
}

interface SyncGroup {
  name: string;
  roles: SyncGroupRole[];
  createdAt: number;
  ttlTimer: ReturnType<typeof setTimeout>;
  lastRun: SyncRunResult | null;
}

interface SyncStep {
  role: string;
  action: string;
  args?: Record<string, unknown>;
  barrier?: string;
  label?: string;
  on_error?: "stop" | "skip" | "retry";
}

interface SyncStepResult {
  role: string;
  stepIndex: number;
  action: string;
  status: "OK" | "FAIL" | "SKIP" | "BARRIER";
  message: string;
  durationMs: number;
}

interface SyncRunResult {
  groupName: string;
  totalMs: number;
  results: Map<string, SyncStepResult[]>;
  barrierTimings: Array<{ name: string; role: string; waitedMs: number }>;
  success: boolean;
}

// ── Constants ──

const SYNC_MAX_GROUPS = 5;
const SYNC_MAX_ROLES = 10;
const SYNC_MAX_STEPS = 30;
const SYNC_MAX_DURATION = 120_000;
const SYNC_BARRIER_TIMEOUT = 30_000;
const SYNC_TTL_MS = 5 * 60 * 1000;
const SYNC_ASSERT_MAX_RETRIES = 5;
const SYNC_ASSERT_RETRY_DELAY = 500;
const SYNC_ASSERT_DEFAULT_DELAY = 1000;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const SYNC_BLOCKED_ACTIONS = new Set([
  // Security-sensitive
  "system_shell", "shell",
  "browser_evaluate",
  // Self-referential
  "sync_create_group", "sync_run", "sync_assert_cross",
  "sync_status", "sync_list", "sync_destroy",
  "sync",
  // Flow nesting
  "flow_batch", "flow_run", "flow_parallel",
  "batch_commands", "run_flow", "parallel",
  // Recorder conflicts
  "recorder_start", "recorder_stop", "recorder_play", "recorder",
  // Dangerous
  "install_app", "push_file",
]);

// ── Module state ──

const activeGroups = new Map<string, SyncGroup>();

// ── Helpers ──

function validateStepArgs(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ValidationError(`Forbidden key "${key}" in step args`);
    }
  }
}

function isSyncActionAllowed(actionName: string): boolean {
  if (SYNC_BLOCKED_ACTIONS.has(actionName)) return false;
  return getRegisteredToolNames().has(actionName);
}

function getGroup(name: string): SyncGroup {
  const group = activeGroups.get(name);
  if (!group) throw new SyncGroupNotFoundError(name);
  return group;
}

function getDeviceIdForRole(group: SyncGroup, role: string): string {
  const r = group.roles.find(r => r.name === role);
  if (!r) throw new SyncRoleNotFoundError(role, group.name);
  return r.deviceId;
}

function destroyGroupInternal(name: string): void {
  const group = activeGroups.get(name);
  if (!group) return;
  clearTimeout(group.ttlTimer);
  activeGroups.delete(name);
}

// ── Barrier implementation ──

interface BarrierState {
  name: string;
  expectedCount: number;
  arrivedCount: number;
  promise: Promise<void>;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

function createBarrier(name: string, participantCount: number): BarrierState {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const timer = setTimeout(() => {
    reject(new SyncBarrierTimeoutError(name, SYNC_BARRIER_TIMEOUT));
  }, SYNC_BARRIER_TIMEOUT);

  return { name, expectedCount: participantCount, arrivedCount: 0, promise, resolve, timer };
}

function arriveAtBarrier(barrier: BarrierState): void {
  barrier.arrivedCount++;
  if (barrier.arrivedCount >= barrier.expectedCount) {
    clearTimeout(barrier.timer);
    barrier.resolve();
  }
}

// ── Execution engine ──

async function executeSync(
  group: SyncGroup,
  steps: SyncStep[],
  ctx: ToolContext,
  depth: number,
  maxDuration: number,
): Promise<SyncRunResult> {
  const startTime = Date.now();
  const results = new Map<string, SyncStepResult[]>();
  const barrierTimings: SyncRunResult["barrierTimings"] = [];

  // Initialize per-role result arrays
  for (const role of group.roles) {
    results.set(role.name, []);
  }

  // Group steps by role (preserve order)
  const roleQueues = new Map<string, SyncStep[]>();
  for (const role of group.roles) {
    roleQueues.set(role.name, []);
  }
  for (const step of steps) {
    const queue = roleQueues.get(step.role);
    if (!queue) throw new SyncRoleNotFoundError(step.role, group.name);
    queue.push(step);
  }

  // Pre-scan barriers: count participants per barrier
  const barrierParticipants = new Map<string, Set<string>>();
  for (const step of steps) {
    if (step.barrier) {
      if (!barrierParticipants.has(step.barrier)) {
        barrierParticipants.set(step.barrier, new Set());
      }
      barrierParticipants.get(step.barrier)!.add(step.role);
    }
  }

  // Create barriers
  const barriers = new Map<string, BarrierState>();
  for (const [name, participants] of barrierParticipants) {
    barriers.set(name, createBarrier(name, participants.size));
  }

  let globalFailed = false;

  // Execute per-role queues concurrently
  const rolePromises = Array.from(roleQueues.entries()).map(async ([roleName, queue]) => {
    const deviceId = getDeviceIdForRole(group, roleName);
    let stepIndex = 0;

    for (const step of queue) {
      // Duration guard
      if (Date.now() - startTime > maxDuration) {
        results.get(roleName)!.push({
          role: roleName,
          stepIndex: ++stepIndex,
          action: step.action,
          status: "FAIL",
          message: "Max duration exceeded",
          durationMs: 0,
        });
        break;
      }

      if (globalFailed && step.on_error !== "skip") break;

      const stepStart = Date.now();
      stepIndex++;

      try {
        const result = await ctx.handleTool(
          step.action,
          { ...(step.args ?? {}), deviceId },
          depth + 1,
        );

        const text = typeof result === "object" && result !== null && "text" in result
          ? (result as { text: string }).text
          : JSON.stringify(result);

        results.get(roleName)!.push({
          role: roleName,
          stepIndex,
          action: step.action,
          status: "OK",
          message: truncateOutput(text, { maxChars: 200, maxLines: 3 }),
          durationMs: Date.now() - stepStart,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.get(roleName)!.push({
          role: roleName,
          stepIndex,
          action: step.action,
          status: "FAIL",
          message: truncateOutput(msg, { maxChars: 200, maxLines: 3 }),
          durationMs: Date.now() - stepStart,
        });

        if (step.on_error === "skip") continue;
        if (step.on_error === "retry") {
          // Single retry attempt
          try {
            const retryResult = await ctx.handleTool(
              step.action,
              { ...(step.args ?? {}), deviceId },
              depth + 1,
            );
            const text = typeof retryResult === "object" && retryResult !== null && "text" in retryResult
              ? (retryResult as { text: string }).text
              : JSON.stringify(retryResult);
            // Replace last result
            const arr = results.get(roleName)!;
            arr[arr.length - 1] = {
              role: roleName,
              stepIndex,
              action: step.action,
              status: "OK",
              message: `(retry) ${truncateOutput(text, { maxChars: 180, maxLines: 3 })}`,
              durationMs: Date.now() - stepStart,
            };
            // Continue to barrier
          } catch {
            globalFailed = true;
            break;
          }
        } else {
          globalFailed = true;
          break;
        }
      }

      // Handle barrier after step execution
      if (step.barrier) {
        const barrier = barriers.get(step.barrier)!;
        const barrierStart = Date.now();
        arriveAtBarrier(barrier);
        try {
          await barrier.promise;
        } catch (error) {
          results.get(roleName)!.push({
            role: roleName,
            stepIndex: stepIndex,
            action: `barrier:${step.barrier}`,
            status: "FAIL",
            message: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - barrierStart,
          });
          globalFailed = true;
          break;
        }
        const waitedMs = Date.now() - barrierStart;
        barrierTimings.push({ name: step.barrier, role: roleName, waitedMs });
      }
    }
  });

  await Promise.allSettled(rolePromises);

  // Cleanup barrier timers
  for (const barrier of barriers.values()) {
    clearTimeout(barrier.timer);
  }

  const totalMs = Date.now() - startTime;
  const allResults = Array.from(results.values()).flat();
  const success = allResults.every(r => r.status === "OK" || r.status === "BARRIER");

  const result: SyncRunResult = { groupName: group.name, totalMs, results, barrierTimings, success };
  group.lastRun = result;
  return result;
}

function formatSyncResult(result: SyncRunResult, group: SyncGroup): string {
  const allResults = Array.from(result.results.values()).flat();
  const okCount = allResults.filter(r => r.status === "OK").length;
  const totalSteps = allResults.filter(r => !r.action.startsWith("barrier:")).length;
  const status = result.success ? "completed" : "PARTIAL FAILURE";

  const lines: string[] = [
    `Sync ${status}: "${result.groupName}" (${group.roles.length} devices, ${totalSteps} steps)`,
    "",
  ];

  for (const role of group.roles) {
    const roleResults = result.results.get(role.name) ?? [];
    lines.push(`[${role.name}] device: ${role.deviceId}`);

    for (const r of roleResults) {
      if (r.action.startsWith("barrier:")) {
        const barrierName = r.action.replace("barrier:", "");
        if (r.status === "FAIL") {
          lines.push(`  ~~ barrier: ${barrierName} — TIMEOUT`);
        }
        continue;
      }

      // Find barrier timing for this step
      const barrierTiming = result.barrierTimings.find(
        bt => bt.role === role.name && roleResults.indexOf(r) < roleResults.length
      );

      lines.push(`  ${r.stepIndex}. ${r.action}: ${r.status} — ${r.message} (${r.durationMs}ms)`);
    }

    // Show barrier timings inline
    for (const bt of result.barrierTimings.filter(bt => bt.role === role.name)) {
      lines.push(`  ~~ barrier: ${bt.name} — waited ${bt.waitedMs}ms`);
    }

    lines.push("");
  }

  const failedSteps = allResults.filter(r => r.status === "FAIL" && !r.action.startsWith("barrier:"));
  lines.push(`Result: ${okCount}/${totalSteps} steps OK (${group.roles.length} devices) — ${result.totalMs}ms`);

  if (failedSteps.length > 0) {
    lines.push("Failures:");
    for (const f of failedSteps) {
      lines.push(`  ${f.role}#${f.stepIndex}: ${f.message}`);
    }
  }

  return lines.join("\n");
}

// ── Tool handlers ──

export const syncTools: ToolDefinition[] = [
  // create_group
  {
    tool: {
      name: "sync_create_group",
      description: "Create a sync group of 2+ devices with named roles for coordinated testing.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Group name (e.g. 'chat-test')" },
          roles: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Role name (e.g. 'sender', 'receiver')" },
                deviceId: { type: "string", description: "Device ID for this role" },
              },
              required: ["name", "deviceId"],
            },
            description: "Role-to-device mapping (min 2, max 10)",
          },
        },
        required: ["name", "roles"],
      },
    },
    handler: async (args) => {
      const name = args.name as string;
      const roles = args.roles as SyncGroupRole[];

      validateBaselineName(name, "sync group name");

      if (activeGroups.has(name)) {
        throw new SyncGroupExistsError(name);
      }

      if (activeGroups.size >= SYNC_MAX_GROUPS) {
        throw new ValidationError(
          `Maximum sync groups (${SYNC_MAX_GROUPS}) reached. Destroy existing groups first.`
        );
      }

      if (!roles || roles.length < 2) {
        throw new ValidationError("Sync group requires at least 2 roles.");
      }

      if (roles.length > SYNC_MAX_ROLES) {
        throw new ValidationError(`Too many roles (${roles.length}). Maximum is ${SYNC_MAX_ROLES}.`);
      }

      // Validate role names and deviceIds
      const roleNames = new Set<string>();
      for (const role of roles) {
        validateBaselineName(role.name, "role name");
        validateDeviceId(role.deviceId);
        if (roleNames.has(role.name)) {
          throw new ValidationError(`Duplicate role name: "${role.name}"`);
        }
        roleNames.add(role.name);
      }

      const ttlTimer = setTimeout(() => destroyGroupInternal(name), SYNC_TTL_MS);

      const group: SyncGroup = {
        name,
        roles,
        createdAt: Date.now(),
        ttlTimer,
        lastRun: null,
      };

      activeGroups.set(name, group);

      const roleLines = roles.map(r => `  ${r.name}: ${r.deviceId}`).join("\n");
      return { text: `Sync group "${name}" created (${roles.length} devices)\n${roleLines}` };
    },
  },

  // run
  {
    tool: {
      name: "sync_run",
      description: "Execute coordinated steps across devices with barrier synchronization.",
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", description: "Sync group name" },
          steps: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string", description: "Which role executes this step" },
                action: { type: "string", description: "Tool action to execute" },
                args: { type: "object", description: "Action arguments" },
                barrier: { type: "string", description: "Barrier name — all roles with this barrier wait for each other" },
                label: { type: "string", description: "Step label" },
                on_error: { type: "string", enum: ["stop", "skip", "retry"], description: "Error handling (default: stop)" },
              },
              required: ["role", "action"],
            },
            description: "Sync steps with role targeting and barriers",
          },
          maxDuration: { type: "number", description: "Max total duration ms (default: 60000)" },
        },
        required: ["group", "steps"],
      },
    },
    handler: async (args, ctx, depth = 0) => {
      if (depth > MAX_RECURSION_DEPTH) {
        throw new MobileError(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded.`, "MAX_RECURSION");
      }

      const groupName = args.group as string;
      const steps = args.steps as SyncStep[];
      const maxDuration = Math.min((args.maxDuration as number) || 60_000, SYNC_MAX_DURATION);

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

      const result = await executeSync(group, steps, ctx, depth, maxDuration);
      return { text: formatSyncResult(result, group) };
    },
  },

  // assert_cross
  {
    tool: {
      name: "sync_assert_cross",
      description: "Cross-device assertion: perform action on source device, verify result on target device with retries.",
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", description: "Sync group name" },
          source_role: { type: "string", description: "Role that performs the source action" },
          source_action: { type: "string", description: "Action to execute on source device" },
          source_args: { type: "object", description: "Source action arguments" },
          target_role: { type: "string", description: "Role that verifies the result" },
          target_action: { type: "string", description: "Assertion action on target device" },
          target_args: { type: "object", description: "Target action arguments" },
          delay_ms: { type: "number", description: "Delay between source and target (default: 1000)" },
          retries: { type: "number", description: "Max target assertion retries (default: 3)" },
          label: { type: "string", description: "Assertion label" },
        },
        required: ["group", "source_role", "source_action", "target_role", "target_action"],
      },
    },
    handler: async (args, ctx, depth = 0) => {
      if (depth > MAX_RECURSION_DEPTH) {
        throw new MobileError(`Maximum recursion depth (${MAX_RECURSION_DEPTH}) exceeded.`, "MAX_RECURSION");
      }

      const groupName = args.group as string;
      const sourceRole = args.source_role as string;
      const sourceAction = args.source_action as string;
      const sourceArgs = (args.source_args ?? {}) as Record<string, unknown>;
      const targetRole = args.target_role as string;
      const targetAction = args.target_action as string;
      const targetArgs = (args.target_args ?? {}) as Record<string, unknown>;
      const delayMs = Math.min((args.delay_ms as number) || SYNC_ASSERT_DEFAULT_DELAY, 30_000);
      const retries = Math.min((args.retries as number) || 3, SYNC_ASSERT_MAX_RETRIES);
      const label = (args.label as string) || `${sourceAction} → ${targetAction}`;

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
          depth + 1,
        );
        sourceText = typeof result === "object" && result !== null && "text" in result
          ? (result as { text: string }).text
          : JSON.stringify(result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          text: `Cross-assert FAILED (${label})\n  source [${sourceRole}]: ${sourceAction} FAIL — ${msg} (${Date.now() - sourceStart}ms)`,
          isError: true,
        };
      }
      const sourceMs = Date.now() - sourceStart;

      // Delay
      await new Promise(r => setTimeout(r, delayMs));

      // Target assertion with retries
      let lastError = "";
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const result = await ctx.handleTool(
            targetAction,
            { ...targetArgs, deviceId: targetDeviceId },
            depth + 1,
          );
          const targetText = typeof result === "object" && result !== null && "text" in result
            ? (result as { text: string }).text
            : JSON.stringify(result);

          const totalMs = Date.now() - totalStart;
          return {
            text: [
              `Cross-assert PASSED (${label}) — ${totalMs}ms`,
              `  source [${sourceRole}]: ${sourceAction} OK — ${truncateOutput(sourceText, { maxChars: 150, maxLines: 2 })} (${sourceMs}ms)`,
              `  delay: ${delayMs}ms`,
              `  target [${targetRole}]: ${targetAction} OK — ${truncateOutput(targetText, { maxChars: 150, maxLines: 2 })} (attempt ${attempt}/${retries})`,
            ].join("\n"),
          };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, SYNC_ASSERT_RETRY_DELAY));
          }
        }
      }

      const totalMs = Date.now() - totalStart;
      return {
        text: [
          `Cross-assert FAILED (${label}) — ${totalMs}ms`,
          `  source [${sourceRole}]: ${sourceAction} OK — ${truncateOutput(sourceText, { maxChars: 150, maxLines: 2 })} (${sourceMs}ms)`,
          `  delay: ${delayMs}ms`,
          `  target [${targetRole}]: ${targetAction} FAIL after ${retries} retries — ${lastError}`,
        ].join("\n"),
        isError: true,
      };
    },
  },

  // status
  {
    tool: {
      name: "sync_status",
      description: "Show details of a sync group and its last run result.",
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", description: "Sync group name" },
        },
        required: ["group"],
      },
    },
    handler: async (args) => {
      const group = getGroup(args.group as string);
      const ageMs = Date.now() - group.createdAt;
      const ageSec = Math.round(ageMs / 1000);
      const ttlRemaining = Math.max(0, Math.round((SYNC_TTL_MS - ageMs) / 1000));

      const lines = [
        `Sync group: "${group.name}"`,
        `  Roles: ${group.roles.map(r => `${r.name}=${r.deviceId}`).join(", ")}`,
        `  Created: ${ageSec}s ago (TTL: ${ttlRemaining}s remaining)`,
      ];

      if (group.lastRun) {
        const lr = group.lastRun;
        const allResults = Array.from(lr.results.values()).flat();
        const okCount = allResults.filter(r => r.status === "OK").length;
        const totalSteps = allResults.filter(r => !r.action.startsWith("barrier:")).length;
        lines.push(`  Last run: ${lr.success ? "OK" : "FAILED"} — ${okCount}/${totalSteps} steps (${lr.totalMs}ms)`);
      } else {
        lines.push("  Last run: none");
      }

      return { text: lines.join("\n") };
    },
  },

  // list
  {
    tool: {
      name: "sync_list",
      description: "List all active sync groups.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => {
      if (activeGroups.size === 0) {
        return { text: "No active sync groups." };
      }

      const lines = ["Sync groups:"];
      for (const group of activeGroups.values()) {
        const status = group.lastRun
          ? (group.lastRun.success ? "idle (last: OK)" : "idle (last: FAILED)")
          : "idle";
        lines.push(`  ${group.name} — ${group.roles.length} devices (${status})`);
      }

      return { text: lines.join("\n") };
    },
  },

  // destroy
  {
    tool: {
      name: "sync_destroy",
      description: "Destroy a sync group and release resources.",
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", description: "Sync group name" },
        },
        required: ["group"],
      },
    },
    handler: async (args) => {
      const name = args.group as string;
      if (!activeGroups.has(name)) {
        throw new SyncGroupNotFoundError(name);
      }
      destroyGroupInternal(name);
      return { text: `Sync group "${name}" destroyed.` };
    },
  },
];

// ── Cleanup (for testing) ──

export function _resetSyncState(): void {
  for (const group of activeGroups.values()) {
    clearTimeout(group.ttlTimer);
  }
  activeGroups.clear();
}
