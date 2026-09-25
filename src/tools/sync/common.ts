import { getRegisteredToolNames, resolveToolIdentity } from "../registry.js";
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
  timedOut: boolean;
  cancelled?: boolean;
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

const FORBIDDEN_KEYS = {
  ["__proto__"]: true,
  ["constructor"]: true,
  ["prototype"]: true,
} as const satisfies Readonly<Record<string, true>>;

const SYNC_BLOCKED_ACTIONS: Readonly<Record<string, true>> = {
  // Security-sensitive
  system_shell: true,
  shell: true,
  browser_evaluate: true,
  debug_eval: true,
  debug_set_var: true,
  // Self-referential
  sync_create_group: true,
  sync_run: true,
  sync_assert_cross: true,
  sync_status: true,
  sync_list: true,
  sync_destroy: true,
  sync: true,
  // Flow nesting
  flow_batch: true,
  flow_run: true,
  flow_parallel: true,
  batch_commands: true,
  run_flow: true,
  parallel: true,
  // Recorder conflicts
  recorder_start: true,
  recorder_stop: true,
  recorder_play: true,
  recorder: true,
  // Dangerous
  app_install: true,
  app_uninstall: true,
  system_file_push: true,
  install_app: true,
  uninstall_app: true,
  push_file: true,
};

// ── Module state ──

export const activeGroups = new Map<string, SyncGroup>();

// ── Helpers ──

export function validateStepArgs(args: Record<string, unknown>): void {
  for (const key of Object.keys(args)) {
    if (Object.hasOwn(FORBIDDEN_KEYS, key)) {
      throw new ValidationError(`Forbidden key "${key}" in step args`);
    }
  }
}

export function isSyncActionAllowed(
  actionName: string,
  actionArgs: Record<string, unknown> = {},
): boolean {
  if (Object.hasOwn(SYNC_BLOCKED_ACTIONS, actionName)) return false;
  if (!getRegisteredToolNames().has(actionName)) return false;

  const identity = resolveToolIdentity(actionName, actionArgs);
  if (!identity) return false;
  if (Object.hasOwn(SYNC_BLOCKED_ACTIONS, identity.canonical)) return false;
  const subAction = identity.args.action;
  return typeof subAction !== "string"
    || !Object.hasOwn(SYNC_BLOCKED_ACTIONS, `${identity.canonical}_${subAction}`);
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

// ── Deadline and barrier helpers ──

export class SyncTimeoutError extends Error {
  constructor(message = "Max duration exceeded") {
    super(message);
    this.name = "SyncTimeoutError";
  }
}

export class SyncCancellationError extends Error {
  constructor() {
    super("Sync run was cancelled.");
    this.name = "SyncCancellationError";
  }
}

/**
 * Race a nested sync operation against the remaining run deadline or a
 * cooperative cancellation signal.
 *
 * Once the deadline or cancellation wins, the nested promise is deliberately
 * detached so the orchestrator can return promptly. Its rejection is still
 * observed to avoid an unhandled rejection if the underlying handler
 * eventually fails.
 */
export async function runWithSyncDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  signal?: AbortSignal,
): Promise<T> {
  if (timeoutMs <= 0) {
    onTimeout();
    throw new SyncTimeoutError();
  }
  if (signal?.aborted) {
    throw new SyncCancellationError();
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  let timeoutTriggered = false;
  let cancellationCleanup: (() => void) | undefined;
  let cancellationPromise: Promise<never> | undefined;

  if (signal) {
    cancellationPromise = new Promise<never>((_, reject) => {
      const onAbort = (): void => {
        if (!timeoutTriggered) reject(new SyncCancellationError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      cancellationCleanup = () => signal.removeEventListener("abort", onAbort);
    });
  }

  const operationPromise = Promise.resolve().then(() => {
    if (signal?.aborted) throw new SyncCancellationError();
    return operation();
  });
  // The operation may outlive this orchestration after timeout/cancellation.
  void operationPromise.catch(() => undefined);

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timeoutTriggered = true;
      reject(new SyncTimeoutError());
      onTimeout();
    }, timeoutMs);
  });

  try {
    return await (cancellationPromise
      ? Promise.race([operationPromise, timeoutPromise, cancellationPromise])
      : Promise.race([operationPromise, timeoutPromise]));
  } catch (error: unknown) {
    if (error instanceof SyncTimeoutError || error instanceof SyncCancellationError) {
      void operationPromise.catch(() => undefined);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
    cancellationCleanup?.();
  }
}

interface BarrierState {
  name: string;
  expectedCount: number;
  arrivedCount: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function createBarrier(name: string, participantCount: number): BarrierState {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A role may stop before reaching this barrier. Keep a rejection observer
  // attached even when no role awaits the rejected barrier promise.
  void promise.catch(() => undefined);

  const timer = setTimeout(() => {
    reject(new SyncBarrierTimeoutError(name, SYNC_BARRIER_TIMEOUT));
  }, SYNC_BARRIER_TIMEOUT);

  return { name, expectedCount: participantCount, arrivedCount: 0, promise, resolve, reject, timer };
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
  parentSignal: AbortSignal | undefined = ctx.signal,
): Promise<SyncRunResult> {
  const startTime = Date.now();
  const deadline = startTime + Math.max(0, maxDuration);
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

  // Each barrier name may identify multiple phases. Match the nth occurrence
  // within each role's queue so later phases do not reuse a resolved promise.
  const barrierSpecs = new Map<string, { name: string; participants: Set<string> }>();
  const barrierKeysByRole = new Map<string, string[]>();
  for (const [roleName, queue] of roleQueues) {
    const occurrences = new Map<string, number>();
    const keys: string[] = [];
    for (const step of queue) {
      if (!step.barrier) {
        keys.push("");
        continue;
      }
      const occurrence = occurrences.get(step.barrier) ?? 0;
      occurrences.set(step.barrier, occurrence + 1);
      const key = JSON.stringify([step.barrier, occurrence]);
      keys.push(key);
      let spec = barrierSpecs.get(key);
      if (!spec) {
        spec = { name: step.barrier, participants: new Set() };
        barrierSpecs.set(key, spec);
      }
      spec.participants.add(roleName);
    }
    barrierKeysByRole.set(roleName, keys);
  }

  const barriers = new Map<string, BarrierState>();
  for (const [key, spec] of barrierSpecs) {
    barriers.set(key, createBarrier(spec.name, spec.participants.size));
  }

  let globalFailed = false;
  let runStopped = false;
  let runTimedOut = false;
  let runCancelled = false;
  const runController = new AbortController();
  const remainingMs = (): number => Math.max(0, deadline - Date.now());
  const abortRun = (timedOut = true): void => {
    runStopped = true;
    runTimedOut ||= timedOut;
    if (!runController.signal.aborted) runController.abort();
    for (const barrier of barriers.values()) {
      barrier.reject(timedOut ? new SyncTimeoutError() : new SyncCancellationError());
    }
  };
  const abortFromParent = (): void => {
    runCancelled = true;
    abortRun(false);
  };
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  if (parentSignal?.aborted) abortFromParent();
  const deadlineTimer = setTimeout(() => abortRun(), remainingMs());
  const timeoutMessage = "Max duration exceeded";

  const recordTimeout = (
    roleName: string,
    step: SyncStep,
    stepIndex: number,
    durationMs: number,
  ): void => {
    results.get(roleName)!.push({
      role: roleName,
      stepIndex,
      action: step.action,
      status: "FAIL",
      message: timeoutMessage,
      durationMs,
    });
  };

  const isRunTimeout = (error: unknown): boolean =>
    error instanceof SyncTimeoutError || runTimedOut || remainingMs() <= 0;

  // Execute per-role queues concurrently
  const rolePromises = Array.from(roleQueues.entries()).map(async ([roleName, queue]) => {
    const deviceId = getDeviceIdForRole(group, roleName);

    for (const [queueIndex, step] of queue.entries()) {
      const stepIndex = queueIndex + 1;
      // The run deadline is absolute: it also covers time spent in previous
      // actions, retries, barriers, and waits.
      if (runTimedOut || remainingMs() <= 0) {
        abortRun();
        recordTimeout(roleName, step, stepIndex, 0);
        break;
      }
      if (runStopped || (globalFailed && step.on_error !== "skip")) break;

      const stepStart = Date.now();
      let actionResult: unknown;
      let actionSucceeded = false;
      let retried = false;

      try {
        actionResult = await runWithSyncDeadline(
          () => ctx.handleTool(
            step.action,
            { ...(step.args ?? {}), deviceId },
            depth + 1,
            runController.signal,
          ),
          remainingMs(),
          abortRun,
          runController.signal,
        );
        actionSucceeded = true;
      } catch (error: unknown) {
        if (isRunTimeout(error)) {
          abortRun();
          recordTimeout(roleName, step, stepIndex, Date.now() - stepStart);
          break;
        }
        if (runStopped) break;

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
          if (remainingMs() <= 0) {
            abortRun();
            const arr = results.get(roleName)!;
            arr[arr.length - 1] = {
              role: roleName,
              stepIndex,
              action: step.action,
              status: "FAIL",
              message: timeoutMessage,
              durationMs: Date.now() - stepStart,
            };
            break;
          }

          retried = true;
          try {
            actionResult = await runWithSyncDeadline(
              () => ctx.handleTool(
                step.action,
                { ...(step.args ?? {}), deviceId },
                depth + 1,
                runController.signal,
              ),
              remainingMs(),
              abortRun,
              runController.signal,
            );
            actionSucceeded = true;
          } catch (retryError: unknown) {
            if (isRunTimeout(retryError)) {
              abortRun();
              const arr = results.get(roleName)!;
              arr[arr.length - 1] = {
                role: roleName,
                stepIndex,
                action: step.action,
                status: "FAIL",
                message: timeoutMessage,
                durationMs: Date.now() - stepStart,
              };
              break;
            }
            if (runStopped) break;
            globalFailed = true;
            abortRun(false);
            break;
          }
        } else {
          globalFailed = true;
          abortRun(false);
          break;
        }
      }

      if (!actionSucceeded) break;
      if (runTimedOut || remainingMs() <= 0) {
        abortRun();
        recordTimeout(roleName, step, stepIndex, Date.now() - stepStart);
        break;
      }

      const text = typeof actionResult === "object" && actionResult !== null && "text" in actionResult && typeof actionResult.text === "string"
        ? actionResult.text
        : JSON.stringify(actionResult) ?? String(actionResult);
      const actionRecord: SyncStepResult = {
        role: roleName,
        stepIndex,
        action: step.action,
        status: "OK",
        message: retried
          ? `(retry) ${truncateOutput(text, { maxChars: 180, maxLines: 3 })}`
          : truncateOutput(text, { maxChars: 200, maxLines: 3 }),
        durationMs: Date.now() - stepStart,
      };
      const roleResults = results.get(roleName)!;
      if (retried) roleResults[roleResults.length - 1] = actionRecord;
      else roleResults.push(actionRecord);
      if (runStopped) break;

      // Handle barrier after step execution. Barrier waiting is subject to the
      // same absolute run deadline as the action itself.
      if (step.barrier) {
        const barrierKey = barrierKeysByRole.get(roleName)![queueIndex]!;
        const barrier = barriers.get(barrierKey)!;
        const barrierStart = Date.now();
        if (runTimedOut || remainingMs() <= 0) {
          abortRun();
          results.get(roleName)!.push({
            role: roleName,
            stepIndex,
            action: `barrier:${step.barrier}`,
            status: "FAIL",
            message: timeoutMessage,
            durationMs: 0,
          });
          break;
        }

        arriveAtBarrier(barrier);
        try {
          await runWithSyncDeadline(
            () => barrier.promise,
            Math.min(SYNC_BARRIER_TIMEOUT, remainingMs()),
            abortRun,
            runController.signal,
          );
        } catch (error: unknown) {
          const timeout = isRunTimeout(error);
          results.get(roleName)!.push({
            role: roleName,
            stepIndex,
            action: `barrier:${step.barrier}`,
            status: "FAIL",
            message: timeout
              ? timeoutMessage
              : error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - barrierStart,
          });
          // A barrier failure stops peer roles; only a run deadline is an
          // incomplete run.
          abortRun(timeout);
          globalFailed = true;
          break;
        }
        if (runTimedOut || remainingMs() <= 0) {
          abortRun();
          results.get(roleName)!.push({
            role: roleName,
            stepIndex,
            action: `barrier:${step.barrier}`,
            status: "FAIL",
            message: timeoutMessage,
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

  try {
    await Promise.allSettled(rolePromises);
  } finally {
    clearTimeout(deadlineTimer);
    parentSignal?.removeEventListener("abort", abortFromParent);
    // Cleanup barrier timers
    for (const barrier of barriers.values()) {
      clearTimeout(barrier.timer);
    }
  }

  const totalMs = Date.now() - startTime;
  const allResults = Array.from(results.values()).flat();
  const deadlineExpired = Date.now() >= deadline;
  if (deadlineExpired) abortRun();
  const success = !runCancelled && !runStopped && !runTimedOut && !deadlineExpired
    && allResults.every(r => r.status === "OK" || r.status === "BARRIER");

  const result: SyncRunResult = {
    groupName: group.name,
    totalMs,
    results,
    barrierTimings,
    success,
    timedOut: runTimedOut || deadlineExpired,
    cancelled: runCancelled,
  };
  group.lastRun = result;
  return result;
}


export function formatSyncResult(result: SyncRunResult, group: SyncGroup): string {
  const allResults = Array.from(result.results.values()).flat();
  const okCount = allResults.filter(r => r.status === "OK").length;
  const totalSteps = allResults.filter(r => !r.action.startsWith("barrier:")).length;
  const status = result.success
    ? "completed"
    : result.timedOut
      ? "INCOMPLETE (max duration exceeded)"
      : result.cancelled === true
        ? "CANCELLED"
        : "PARTIAL FAILURE";

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
