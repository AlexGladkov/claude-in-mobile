import { getRegisteredToolNames } from "../registry.js";
import type { ToolContext } from "../context.js";
import {
  ValidationError,
  SyncGroupNotFoundError,
  SyncBarrierTimeoutError,
  SyncRoleNotFoundError,
} from "../../errors.js";
import { truncateOutput } from "../../utils/truncate.js";
import { z } from "../define-tool.js";
import { SYNC } from "../../constants/timeouts.js";

// ── Types ──

export interface SyncGroupRole {
  name: string;
  deviceId: string;
}

export interface SyncGroup {
  name: string;
  roles: SyncGroupRole[];
  createdAt: number;
  ttlTimer: ReturnType<typeof setTimeout>;
  lastRun: SyncRunResult | null;
}

export interface SyncStep {
  role: string;
  action: string;
  args?: Record<string, unknown>;
  barrier?: string;
  label?: string;
  on_error?: "stop" | "skip" | "retry";
}

export interface SyncStepResult {
  role: string;
  stepIndex: number;
  action: string;
  status: "OK" | "FAIL" | "SKIP" | "BARRIER";
  message: string;
  durationMs: number;
}

export interface SyncRunResult {
  groupName: string;
  totalMs: number;
  results: Map<string, SyncStepResult[]>;
  barrierTimings: Array<{ name: string; role: string; waitedMs: number }>;
  success: boolean;
}

// ── Constants ──

export const SYNC_MAX_GROUPS = 5;
export const SYNC_MAX_ROLES = 10;
export const SYNC_MAX_STEPS = 30;
export const SYNC_MAX_DURATION = 120_000;
export const SYNC_BARRIER_TIMEOUT = SYNC.BARRIER_TIMEOUT_MS;
export const SYNC_TTL_MS = 5 * 60 * 1000;
export const SYNC_ASSERT_MAX_RETRIES = 5;
export const SYNC_ASSERT_RETRY_DELAY = 500;
export const SYNC_ASSERT_DEFAULT_DELAY = 1000;

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

export const activeGroups = new Map<string, SyncGroup>();

// ── Helpers ──

export function validateStepArgs(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new ValidationError(`Forbidden key "${key}" in step args`);
    }
  }
}

export function isSyncActionAllowed(actionName: string): boolean {
  if (SYNC_BLOCKED_ACTIONS.has(actionName)) return false;
  return getRegisteredToolNames().has(actionName);
}

export function getGroup(name: string): SyncGroup {
  const group = activeGroups.get(name);
  if (!group) throw new SyncGroupNotFoundError(name);
  return group;
}

export function getDeviceIdForRole(group: SyncGroup, role: string): string {
  const r = group.roles.find(r => r.name === role);
  if (!r) throw new SyncRoleNotFoundError(role, group.name);
  return r.deviceId;
}

export function destroyGroupInternal(name: string): void {
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

export async function executeSync(
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

export function formatSyncResult(result: SyncRunResult, group: SyncGroup): string {
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

// Zod schemas
export const roleSchema = z.object({
  name: z.string().describe("Role name (e.g. 'sender', 'receiver')"),
  deviceId: z.string().describe("Device ID for this role"),
});

export const stepSchema = z.object({
  role: z.string().describe("Which role executes this step"),
  action: z.string().describe("Tool action to execute"),
  args: z.record(z.string(), z.unknown()).optional().describe("Action arguments"),
  barrier: z.string().optional().describe("Barrier name — all roles with this barrier wait for each other"),
  label: z.string().optional().describe("Step label"),
  on_error: z.enum(["stop", "skip", "retry"]).optional().describe("Error handling (default: stop)"),
});
