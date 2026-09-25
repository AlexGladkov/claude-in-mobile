import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../context.js";
import { registerTools, resetRegistry } from "../registry.js";
import { syncAssertCross } from "./assert-cross.js";
import { syncRun } from "./run.js";
import {
  activeGroups,
  executeSync,
  formatSyncResult,
  type SyncGroup,
  type SyncStep,
} from "./common.js";

const roles = [
  { name: "sender", deviceId: "device-a" },
  { name: "receiver", deviceId: "device-b" },
];

function makeGroup(name: string): SyncGroup {
  return {
    name,
    roles,
    createdAt: Date.now(),
    ttlTimer: setTimeout(() => undefined, 60_000),
    lastRun: null,
  };
}

function makeContext(
  handleTool: ToolContext["handleTool"],
  signal?: AbortSignal,
): ToolContext {
  return { handleTool, signal } as unknown as ToolContext;
}

function registerAction(name: string): void {
  registerTools([{
    tool: { name, description: name, inputSchema: { type: "object", properties: {} } },
    handler: async () => ({ text: "ok" }),
  }]);
}

beforeEach(() => {
  resetRegistry();
  for (const name of ["never_action", "quick_action", "later_action", "assert_action"]) {
    registerAction(name);
  }
  vi.useFakeTimers();
});

afterEach(() => {
  for (const group of activeGroups.values()) clearTimeout(group.ttlTimer);
  activeGroups.clear();
  resetRegistry();
  vi.useRealTimers();
});

describe("sync run deadlines", () => {
  it("aborts a never-settling action and does not retry or dispatch later steps", async () => {
    const calls: string[] = [];
    let actionSignal: AbortSignal | undefined;
    const ctx = makeContext(async (name, _args, _depth, signal) => {
      calls.push(name);
      actionSignal = signal;
      return new Promise<unknown>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const group = makeGroup("action-timeout");
    const steps: SyncStep[] = [
      { role: "sender", action: "never_action", on_error: "retry" },
      { role: "sender", action: "later_action" },
    ];

    const runPromise = executeSync(group, steps, ctx, 0, 25);
    await vi.advanceTimersByTimeAsync(25);
    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(actionSignal?.aborted).toBe(true);
    expect(calls).toEqual(["never_action"]);
    expect(result.results.get("sender")?.[0]).toMatchObject({
      action: "never_action",
      status: "FAIL",
      message: "Max duration exceeded",
    });
    expect(result.timedOut).toBe(true);
    expect(formatSyncResult(result, group))
      .toContain("Sync INCOMPLETE (max duration exceeded)");
  });
  it("stops queued steps and retries promptly when the parent aborts", async () => {
    const parent = new AbortController();
    const calls: string[] = [];
    let actionSignal: AbortSignal | undefined;
    const ctx = makeContext(async (name, _args, _depth, signal) => {
      calls.push(name);
      actionSignal = signal;
      return new Promise<unknown>(() => {});
    }, parent.signal);
    const group = makeGroup("parent-cancel");
    const runPromise = executeSync(group, [
      { role: "sender", action: "never_action", on_error: "retry" },
      { role: "sender", action: "later_action" },
    ], ctx, 0, 1_000);

    await Promise.resolve();
    parent.abort();
    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(formatSyncResult(result, group)).toContain("Sync CANCELLED");
    expect(actionSignal?.aborted).toBe(true);
    expect(calls).toEqual(["never_action"]);
  });

  it("does not start a role queue when the parent is already aborted", async () => {
    const parent = new AbortController();
    parent.abort();
    const calls: string[] = [];
    const ctx = makeContext(async (name) => {
      calls.push(name);
      return { text: "unexpected" };
    }, parent.signal);

    const result = await executeSync(
      makeGroup("already-cancelled"),
      [{ role: "sender", action: "quick_action" }],
      ctx,
      0,
      1_000,
    );

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(calls).toEqual([]);
  });

  it("numbers each role's steps sequentially starting at one", async () => {
    const ctx = makeContext(async (name) => ({ text: name }));
    const group = makeGroup("step-indexes");
    const result = await executeSync(group, [
      { role: "sender", action: "quick_action" },
      { role: "sender", action: "later_action" },
    ], ctx, 0, 1_000);

    expect(result.results.get("sender")?.map((entry) => entry.stepIndex)).toEqual([1, 2]);
  });

  it("bounds a barrier when another role never reaches it", async () => {
    const calls: string[] = [];
    let signal: AbortSignal | undefined;
    const ctx = makeContext(async (name, _args, _depth, actionSignal) => {
      calls.push(name);
      signal = actionSignal;
      if (name === "quick_action") return { text: "ok" };
      return new Promise<unknown>((_resolve, reject) => {
        actionSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const group = makeGroup("barrier-timeout");
    const steps: SyncStep[] = [
      { role: "sender", action: "quick_action", barrier: "sync-point" },
      { role: "sender", action: "later_action" },
      { role: "receiver", action: "never_action", barrier: "sync-point" },
    ];

    const runPromise = executeSync(group, steps, ctx, 0, 30);
    await vi.advanceTimersByTimeAsync(30);
    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(signal?.aborted).toBe(true);
    expect(calls).toEqual(["quick_action", "never_action"]);
    expect(result.results.get("sender")?.some(entry => entry.action === "later_action")).toBe(false);
    expect(result.results.get("sender")?.some(entry => entry.action === "barrier:sync-point" && entry.status === "FAIL")).toBe(true);
  });
});
describe("sync action policy", () => {
  it("rejects persistent device mutation aliases and meta actions before dispatch", async () => {
    const blocked = [
      { action: "app_install", args: {} },
      { action: "app_uninstall", args: {} },
      { action: "system_file_push", args: {} },
      { action: "install_app", args: {} },
      { action: "uninstall_app", args: {} },
      { action: "push_file", args: {} },
      { action: "app", args: { action: "install" } },
      { action: "app", args: { action: "uninstall" } },
      { action: "system", args: { action: "file_push" } },
    ] as const;
    for (const { action } of blocked) registerAction(action);

    const calls: string[] = [];
    const ctx = makeContext(async (name) => {
      calls.push(name);
      return { text: "unexpected" };
    });
    const group = makeGroup("sync-policy");
    activeGroups.set(group.name, group);

    for (const { action, args } of blocked) {
      await expect(syncRun.handler({
        group: group.name,
        steps: [{ role: "sender", action, args }],
      }, ctx)).rejects.toThrow("not allowed");
    }
    expect(calls).toEqual([]);
  });
});

describe("sync cross-assert deadlines", () => {
  it("returns a terminal timeout for a never-settling source without starting target retries", async () => {
    const calls: string[] = [];
    let actionSignal: AbortSignal | undefined;
    const ctx = makeContext(async (name, _args, _depth, signal) => {
      calls.push(name);
      actionSignal = signal;
      return new Promise<unknown>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const group = makeGroup("cross-timeout");
    activeGroups.set(group.name, group);
    const handler = syncAssertCross.handler;

    const resultPromise = handler({
      group: group.name,
      source_role: "sender",
      source_action: "assert_action",
      target_role: "receiver",
      target_action: "assert_action",
      delay_ms: 1,
      retries: 5,
      maxDuration: 20,
    }, ctx);
    await vi.advanceTimersByTimeAsync(20);
    const result = await resultPromise as { text: string; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Max duration exceeded");
    expect(actionSignal?.aborted).toBe(true);
    expect(calls).toEqual(["assert_action"]);
  });
  it("settles a deferred source promptly on parent cancellation without starting the target", async () => {
    const parent = new AbortController();
    const calls: string[] = [];
    let sourceSignal: AbortSignal | undefined;
    const ctx = makeContext(async (name, _args, _depth, signal) => {
      calls.push(name);
      sourceSignal = signal;
      return new Promise<unknown>(() => {});
    }, parent.signal);
    const group = makeGroup("cross-parent-cancel");
    activeGroups.set(group.name, group);

    const resultPromise = syncAssertCross.handler({
      group: group.name,
      source_role: "sender",
      source_action: "assert_action",
      target_role: "receiver",
      target_action: "quick_action",
      delay_ms: 0,
      retries: 5,
      maxDuration: 1_000,
    }, ctx);
    await Promise.resolve();
    parent.abort();

    const result = await resultPromise as { text: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.text).toContain("CANCELLED");
    expect(sourceSignal?.aborted).toBe(true);
    expect(calls).toEqual(["assert_action"]);
  });

  it("does not retry a target action after its deadline expires", async () => {
    const calls: string[] = [];
    let targetSignal: AbortSignal | undefined;
    const ctx = makeContext(async (name, _args, _depth, signal) => {
      calls.push(name);
      if (name === "quick_action") return { text: "source ok" };
      targetSignal = signal;
      return new Promise<unknown>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const group = makeGroup("cross-target-timeout");
    activeGroups.set(group.name, group);

    const resultPromise = syncAssertCross.handler({
      group: group.name,
      source_role: "sender",
      source_action: "quick_action",
      target_role: "receiver",
      target_action: "never_action",
      delay_ms: 0,
      retries: 5,
      maxDuration: 20,
    }, ctx);
    await vi.advanceTimersByTimeAsync(20);
    const result = await resultPromise as { text: string; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Max duration exceeded");
    expect(targetSignal?.aborted).toBe(true);
    expect(calls).toEqual(["quick_action", "never_action"]);
  });

  it("performs one target attempt when retries is zero", async () => {
    const calls: string[] = [];
    const ctx = makeContext(async (name) => {
      calls.push(name);
      if (name === "quick_action") return { text: "source ok" };
      throw new Error("target failed");
    });
    const group = makeGroup("cross-zero-retries");
    activeGroups.set(group.name, group);

    const result = await syncAssertCross.handler({
      group: group.name,
      source_role: "sender",
      source_action: "quick_action",
      target_role: "receiver",
      target_action: "never_action",
      delay_ms: 0,
      retries: 0,
      maxDuration: 1000,
    }, ctx) as { text: string; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.text).toContain("after 1 retries");
    expect(calls).toEqual(["quick_action", "never_action"]);
  });
});
