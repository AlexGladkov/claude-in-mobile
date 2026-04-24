import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncTools, _resetSyncState } from "./sync-tools.js";
import { registerTools, resetRegistry } from "./registry.js";
import {
  MobileError,
  ValidationError,
  SyncGroupNotFoundError,
  SyncGroupExistsError,
  SyncRoleNotFoundError,
} from "../errors.js";
import type { ToolContext } from "./context.js";

// ── Helpers ──

function findHandler(name: string) {
  const def = syncTools.find(t => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in syncTools`);
  return def.handler;
}

function makeMockContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "android"),
    } as any,
    getCachedElements: vi.fn(() => []),
    setCachedElements: vi.fn(),
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: vi.fn(async () => ""),
    getElementsForPlatform: vi.fn(async () => []),
    iosTreeToUiElements: vi.fn(() => []),
    formatIOSUITree: vi.fn(() => ""),
    platformParam: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], description: "" },
    handleTool: vi.fn(async () => ({ text: "ok" })),
    ...overrides,
  };
}

const defaultRoles = [
  { name: "sender", deviceId: "emulator-5554" },
  { name: "receiver", deviceId: "emulator-5556" },
];

beforeEach(() => {
  resetRegistry();
  _resetSyncState();

  // Register safe tools for sync action validation
  registerTools([
    {
      tool: { name: "input_tap", description: "Tap", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "tapped" }),
    },
    {
      tool: { name: "input_text", description: "Text", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "typed" }),
    },
    {
      tool: { name: "system_wait", description: "Wait", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "waited" }),
    },
    {
      tool: { name: "ui_assert_visible", description: "Assert", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "visible" }),
    },
    {
      tool: { name: "system_shell", description: "Shell", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "shell executed" }),
    },
  ]);
});

afterEach(() => {
  _resetSyncState();
});

// ── create_group ──

describe("sync_create_group", () => {
  const handler = findHandler("sync_create_group");
  const ctx = makeMockContext();

  it("creates group with valid roles", async () => {
    const result = await handler({ name: "chat-test", roles: defaultRoles }, ctx) as { text: string };
    expect(result.text).toContain("chat-test");
    expect(result.text).toContain("2 devices");
    expect(result.text).toContain("sender");
    expect(result.text).toContain("receiver");
  });

  it("rejects duplicate group name", async () => {
    await handler({ name: "dup-test", roles: defaultRoles }, ctx);
    await expect(handler({ name: "dup-test", roles: defaultRoles }, ctx))
      .rejects.toThrow(SyncGroupExistsError);
  });

  it("rejects invalid group name", async () => {
    await expect(handler({ name: "../evil", roles: defaultRoles }, ctx))
      .rejects.toThrow(MobileError);
  });

  it("rejects less than 2 roles", async () => {
    await expect(handler({
      name: "solo",
      roles: [{ name: "only", deviceId: "emulator-5554" }],
    }, ctx)).rejects.toThrow(ValidationError);
  });

  it("rejects duplicate role names", async () => {
    await expect(handler({
      name: "dup-roles",
      roles: [
        { name: "same", deviceId: "emulator-5554" },
        { name: "same", deviceId: "emulator-5556" },
      ],
    }, ctx)).rejects.toThrow(ValidationError);
  });

  it("rejects too many groups", async () => {
    for (let i = 0; i < 5; i++) {
      await handler({ name: `group-${i}`, roles: defaultRoles }, ctx);
    }
    await expect(handler({ name: "group-overflow", roles: defaultRoles }, ctx))
      .rejects.toThrow(ValidationError);
  });
});

// ── run ──

describe("sync_run", () => {
  const createHandler = findHandler("sync_create_group");
  const runHandler = findHandler("sync_run");

  it("runs steps on multiple devices", async () => {
    const ctx = makeMockContext({
      handleTool: vi.fn(async () => ({ text: "ok" })),
    });

    await createHandler({ name: "run-test", roles: defaultRoles }, ctx);

    const result = await runHandler({
      group: "run-test",
      steps: [
        { role: "sender", action: "input_tap", args: { text: "Send" } },
        { role: "receiver", action: "system_wait", args: { ms: 100 } },
      ],
    }, ctx) as { text: string };

    expect(result.text).toContain("run-test");
    expect(result.text).toContain("OK");
    // handleTool called with deviceId injection
    expect(ctx.handleTool).toHaveBeenCalledWith(
      "input_tap",
      expect.objectContaining({ deviceId: "emulator-5554" }),
      1,
    );
    expect(ctx.handleTool).toHaveBeenCalledWith(
      "system_wait",
      expect.objectContaining({ deviceId: "emulator-5556" }),
      1,
    );
  });

  it("enforces barrier synchronization", async () => {
    const callOrder: string[] = [];
    const ctx = makeMockContext({
      handleTool: vi.fn(async (_name, args) => {
        callOrder.push(`${args.deviceId}:${_name}`);
        return { text: "ok" };
      }),
    });

    await createHandler({ name: "barrier-test", roles: defaultRoles }, ctx);

    const result = await runHandler({
      group: "barrier-test",
      steps: [
        { role: "sender", action: "input_tap", barrier: "sync-point" },
        { role: "receiver", action: "system_wait", barrier: "sync-point" },
        { role: "sender", action: "input_text" },
        { role: "receiver", action: "ui_assert_visible" },
      ],
    }, ctx) as { text: string };

    expect(result.text).toContain("OK");
    expect(result.text).toContain("barrier");
  });

  it("rejects blocked actions", async () => {
    const ctx = makeMockContext();
    await createHandler({ name: "block-test", roles: defaultRoles }, ctx);

    await expect(runHandler({
      group: "block-test",
      steps: [{ role: "sender", action: "system_shell", args: { command: "ls" } }],
    }, ctx)).rejects.toThrow(MobileError);
  });

  it("rejects unknown role in steps", async () => {
    const ctx = makeMockContext();
    await createHandler({ name: "role-test", roles: defaultRoles }, ctx);

    await expect(runHandler({
      group: "role-test",
      steps: [{ role: "nonexistent", action: "input_tap" }],
    }, ctx)).rejects.toThrow(SyncRoleNotFoundError);
  });

  it("rejects too many steps", async () => {
    const ctx = makeMockContext();
    await createHandler({ name: "steps-test", roles: defaultRoles }, ctx);

    const steps = Array.from({ length: 31 }, (_, i) => ({
      role: "sender",
      action: "input_tap",
    }));

    await expect(runHandler({
      group: "steps-test",
      steps,
    }, ctx)).rejects.toThrow(ValidationError);
  });

  it("rejects proto-pollution keys in args", async () => {
    const ctx = makeMockContext();
    await createHandler({ name: "proto-test", roles: defaultRoles }, ctx);

    await expect(runHandler({
      group: "proto-test",
      steps: [{ role: "sender", action: "input_tap", args: { constructor: {} } }],
    }, ctx)).rejects.toThrow(ValidationError);
  });

  it("throws for nonexistent group", async () => {
    const ctx = makeMockContext();
    await expect(runHandler({
      group: "no-group",
      steps: [{ role: "sender", action: "input_tap" }],
    }, ctx)).rejects.toThrow(SyncGroupNotFoundError);
  });

  it("handles step failure with on_error skip", async () => {
    let callCount = 0;
    const ctx = makeMockContext({
      handleTool: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("first fails");
        return { text: "ok" };
      }),
    });

    await createHandler({ name: "skip-test", roles: defaultRoles }, ctx);

    const result = await runHandler({
      group: "skip-test",
      steps: [
        { role: "sender", action: "input_tap", on_error: "skip" },
        { role: "sender", action: "input_text" },
      ],
    }, ctx) as { text: string };

    // Second step should still execute because on_error is "skip"
    expect(callCount).toBe(2);
  });
});

// ── assert_cross ──

describe("sync_assert_cross", () => {
  const createHandler = findHandler("sync_create_group");
  const assertHandler = findHandler("sync_assert_cross");

  it("passes when target assertion succeeds", async () => {
    const ctx = makeMockContext({
      handleTool: vi.fn(async () => ({ text: "found element" })),
    });

    await createHandler({ name: "assert-test", roles: defaultRoles }, ctx);

    const result = await assertHandler({
      group: "assert-test",
      source_role: "sender",
      source_action: "input_tap",
      source_args: { text: "Send" },
      target_role: "receiver",
      target_action: "ui_assert_visible",
      target_args: { text: "Hello" },
      delay_ms: 10, // short for test
    }, ctx) as { text: string };

    expect(result.text).toContain("PASSED");
    expect(result.text).toContain("sender");
    expect(result.text).toContain("receiver");
  });

  it("retries target assertion and succeeds", async () => {
    let targetCalls = 0;
    const ctx = makeMockContext({
      handleTool: vi.fn(async (name) => {
        if (name === "ui_assert_visible") {
          targetCalls++;
          if (targetCalls < 3) throw new Error("not found yet");
        }
        return { text: "ok" };
      }),
    });

    await createHandler({ name: "retry-test", roles: defaultRoles }, ctx);

    const result = await assertHandler({
      group: "retry-test",
      source_role: "sender",
      source_action: "input_tap",
      target_role: "receiver",
      target_action: "ui_assert_visible",
      delay_ms: 10,
      retries: 5,
    }, ctx) as { text: string };

    expect(result.text).toContain("PASSED");
    expect(result.text).toContain("attempt 3/5");
  });

  it("fails after exhausting retries", async () => {
    const ctx = makeMockContext({
      handleTool: vi.fn(async (name) => {
        if (name === "ui_assert_visible") throw new Error("never found");
        return { text: "ok" };
      }),
    });

    await createHandler({ name: "exhaust-test", roles: defaultRoles }, ctx);

    const result = await assertHandler({
      group: "exhaust-test",
      source_role: "sender",
      source_action: "input_tap",
      target_role: "receiver",
      target_action: "ui_assert_visible",
      delay_ms: 10,
      retries: 2,
    }, ctx) as { text: string; isError?: boolean };

    expect(result.text).toContain("FAILED");
    expect(result.text).toContain("2 retries");
    expect(result.isError).toBe(true);
  });

  it("fails if source action fails", async () => {
    const ctx = makeMockContext({
      handleTool: vi.fn(async () => { throw new Error("source error"); }),
    });

    await createHandler({ name: "src-fail-test", roles: defaultRoles }, ctx);

    const result = await assertHandler({
      group: "src-fail-test",
      source_role: "sender",
      source_action: "input_tap",
      target_role: "receiver",
      target_action: "ui_assert_visible",
      delay_ms: 10,
    }, ctx) as { text: string; isError?: boolean };

    expect(result.text).toContain("FAIL");
    expect(result.text).toContain("source error");
    expect(result.isError).toBe(true);
  });

  it("rejects blocked actions", async () => {
    const ctx = makeMockContext();
    await createHandler({ name: "blocked-assert", roles: defaultRoles }, ctx);

    await expect(assertHandler({
      group: "blocked-assert",
      source_role: "sender",
      source_action: "system_shell",
      target_role: "receiver",
      target_action: "ui_assert_visible",
      delay_ms: 10,
    }, ctx)).rejects.toThrow(MobileError);
  });
});

// ── status / list / destroy ──

describe("sync_status", () => {
  const createHandler = findHandler("sync_create_group");
  const statusHandler = findHandler("sync_status");

  it("shows group details", async () => {
    const ctx = makeMockContext();
    await createHandler({ name: "status-test", roles: defaultRoles }, ctx);

    const result = await statusHandler({ group: "status-test" }, ctx) as { text: string };
    expect(result.text).toContain("status-test");
    expect(result.text).toContain("sender");
    expect(result.text).toContain("receiver");
    expect(result.text).toContain("Last run: none");
  });

  it("throws for nonexistent group", async () => {
    const ctx = makeMockContext();
    await expect(statusHandler({ group: "nope" }, ctx)).rejects.toThrow(SyncGroupNotFoundError);
  });
});

describe("sync_list", () => {
  const createHandler = findHandler("sync_create_group");
  const listHandler = findHandler("sync_list");

  it("returns empty when no groups", async () => {
    const ctx = makeMockContext();
    const result = await listHandler({}, ctx) as { text: string };
    expect(result.text).toContain("No active sync groups");
  });

  it("lists all groups", async () => {
    const ctx = makeMockContext();
    await createHandler({ name: "group-a", roles: defaultRoles }, ctx);
    await createHandler({ name: "group-b", roles: defaultRoles }, ctx);

    const result = await listHandler({}, ctx) as { text: string };
    expect(result.text).toContain("group-a");
    expect(result.text).toContain("group-b");
    expect(result.text).toContain("2 devices");
  });
});

describe("sync_destroy", () => {
  const createHandler = findHandler("sync_create_group");
  const destroyHandler = findHandler("sync_destroy");
  const listHandler = findHandler("sync_list");

  it("destroys existing group", async () => {
    const ctx = makeMockContext();
    await createHandler({ name: "destroy-test", roles: defaultRoles }, ctx);

    const result = await destroyHandler({ group: "destroy-test" }, ctx) as { text: string };
    expect(result.text).toContain("destroyed");

    const list = await listHandler({}, ctx) as { text: string };
    expect(list.text).toContain("No active sync groups");
  });

  it("throws for nonexistent group", async () => {
    const ctx = makeMockContext();
    await expect(destroyHandler({ group: "nope" }, ctx)).rejects.toThrow(SyncGroupNotFoundError);
  });
});

// ── TTL auto-destroy ──

describe("TTL", () => {
  it("auto-destroys group after TTL", async () => {
    vi.useFakeTimers();
    const createHandler = findHandler("sync_create_group");
    const listHandler = findHandler("sync_list");
    const ctx = makeMockContext();

    await createHandler({ name: "ttl-test", roles: defaultRoles }, ctx);

    let list = await listHandler({}, ctx) as { text: string };
    expect(list.text).toContain("ttl-test");

    // Advance past TTL (5 min)
    vi.advanceTimersByTime(5 * 60 * 1000 + 100);

    list = await listHandler({}, ctx) as { text: string };
    expect(list.text).toContain("No active sync groups");

    vi.useRealTimers();
  });
});
