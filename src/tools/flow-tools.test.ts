import { describe, it, expect, vi, beforeEach } from "vitest";
import { flowTools } from "./flow-tools.js";
import { formatFlowResults } from "./flow/common.js";
import { registerTools, registerAliases, registerAliasesWithDefaults, resetRegistry } from "./registry.js";
import { MobileError, ValidationError } from "../errors.js";
import type { ToolContext } from "./context.js";
import { MAX_RECURSION_DEPTH } from "./context.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function findHandler(name: string) {
  const def = flowTools.find(t => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in flowTools`);
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

beforeEach(() => {
  resetRegistry();

  // Register some safe tools that flow actions allow
  registerTools([
    {
      tool: { name: "input_tap", description: "Tap", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "tapped" }),
    },
    {
      tool: { name: "system_wait", description: "Wait", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "waited" }),
    },
    {
      tool: { name: "system_shell", description: "Shell", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "shell executed" }),
    },
    {
      tool: { name: "system", description: "System meta-tool", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "system executed" }),
    },
  ]);
  registerTools([
    {
      tool: { name: "debug_eval", description: "Debugger expression evaluation", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "evaluated" }),
    },
    {
      tool: { name: "debug_set_var", description: "Debugger variable mutation", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "mutated" }),
    },
    {
      tool: { name: "app", description: "App meta-tool", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "app executed" }),
    },
  ]);
  registerAliasesWithDefaults({
    shell: { tool: "system", defaults: { action: "shell" } },
    app_install: { tool: "app", defaults: { action: "install" } },
    install_app: { tool: "app", defaults: { action: "install" } },
    uninstall_app: { tool: "app", defaults: { action: "uninstall" } },
    push_file: { tool: "system", defaults: { action: "file_push" } },
  });
});
describe("debugger code execution and mutation flow policy", () => {
  const cases = [
    ["flow_batch", "debug_eval", { commands: [{ name: "debug_eval", arguments: {} }] }],
    ["flow_batch", "debug_set_var", { commands: [{ name: "debug_set_var", arguments: {} }] }],
    ["flow_run", "debug_eval", { steps: [{ action: "debug_eval" }] }],
    ["flow_run", "debug_set_var", { steps: [{ action: "debug_set_var" }] }],
    ["flow_parallel", "debug_eval", { action: "debug_eval", devices: ["device-1"] }],
    ["flow_parallel", "debug_set_var", { action: "debug_set_var", devices: ["device-1"] }],
  ] as const;

  it.each(cases)("%s blocks %s before dispatch", async (toolName, _action, args) => {
    const ctx = makeMockContext();
    await expect(findHandler(toolName)(args, ctx)).rejects.toMatchObject({
      code: "FLOW_SECURITY",
    });
    expect(ctx.handleTool).not.toHaveBeenCalled();
  });
});

describe("persistent device mutation flow policy", () => {
  const cases = [
    ["flow_batch", "install_app", {
      commands: [{ name: "install_app", arguments: { path: "app.apk" } }],
    }],
    ["flow_batch", "system file_push", {
      commands: [{ name: "system", arguments: { action: "file_push", localPath: "secret", remotePath: "/tmp/x" } }],
    }],
    ["flow_run", "app install", {
      steps: [{ action: "app", args: { action: "install", path: "app.apk" } }],
    }],
    ["flow_run", "app uninstall", {
      steps: [{ action: "app", args: { action: "uninstall", package: "com.example.app" } }],
    }],
    ["flow_parallel", "push_file", {
      action: "push_file",
      args: { localPath: "secret", remotePath: "/tmp/x" },
      devices: ["device-1"],
    }],
  ] as const;

  it.each(cases)("%s blocks %s before dispatch", async (toolName, _action, args) => {
    const ctx = makeMockContext();
    await expect(findHandler(toolName)(args, ctx)).rejects.toMatchObject({
      code: "FLOW_SECURITY",
    });
    expect(ctx.handleTool).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// flow_batch — security and validation
// ──────────────────────────────────────────────

describe("flow_batch", () => {
  const handler = findHandler("flow_batch");

  it("throws FLOW_SECURITY for blocked action system_shell", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        commands: [{ name: "system_shell", arguments: { command: "ls" } }],
      }, ctx)
    ).rejects.toThrow(MobileError);

    try {
      await handler({
        commands: [{ name: "system_shell", arguments: { command: "ls" } }],
      }, ctx);
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("FLOW_SECURITY");
      expect((e as MobileError).message).toContain("system_shell");
      expect((e as MobileError).message).toContain("not allowed");
    }
  });

  it("rejects the legacy shell alias before execution", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        commands: [{ name: "shell", arguments: { command: "id" } }],
      }, ctx),
    ).rejects.toMatchObject({ code: "FLOW_SECURITY" });
    expect(ctx.handleTool).not.toHaveBeenCalled();
  });

  it("rejects the generic system shell action before execution", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        commands: [{ name: "system", arguments: { action: "shell", command: "id" } }],
      }, ctx),
    ).rejects.toMatchObject({ code: "FLOW_SECURITY" });
    expect(ctx.handleTool).not.toHaveBeenCalled();
  });

  it("fails closed for aliases with missing or cyclic targets", async () => {
    registerAliases({
      missing_target: "not_registered",
      cycle_a: "cycle_b",
      cycle_b: "cycle_a",
    });
    const ctx = makeMockContext();

    await expect(
      handler({ commands: [{ name: "missing_target" }] }, ctx),
    ).rejects.toMatchObject({ code: "FLOW_SECURITY" });
    await expect(
      handler({ commands: [{ name: "cycle_a" }] }, ctx),
    ).rejects.toMatchObject({ code: "FLOW_SECURITY" });
  });

  it("throws ValidationError for empty commands array", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ commands: [] }, ctx)
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for undefined commands", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ commands: undefined }, ctx)
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for more than 50 commands", async () => {
    const ctx = makeMockContext();
    const commands = Array.from({ length: 51 }, (_, i) => ({
      name: "input_tap",
      arguments: { x: i, y: i },
    }));
    await expect(
      handler({ commands }, ctx)
    ).rejects.toThrow(ValidationError);

    try {
      await handler({ commands }, ctx);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).message).toContain("51");
      expect((e as ValidationError).message).toContain("50");
    }
  });

  it("accepts exactly 50 commands with valid actions", async () => {
    const ctx = makeMockContext();
    const commands = Array.from({ length: 50 }, () => ({
      name: "input_tap",
      arguments: { x: 100, y: 200 },
    }));
    // Should not throw validation error (may fail on actual tool execution but not on validation)
    const result = await handler({ commands }, ctx);
    expect(result).toBeDefined();
  });

  it("blocks system_shell even among other valid commands", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        commands: [
          { name: "input_tap", arguments: { x: 100, y: 200 } },
          { name: "system_shell", arguments: { command: "rm -rf /" } },
          { name: "system_wait", arguments: { ms: 100 } },
        ],
      }, ctx)
    ).rejects.toThrow(MobileError);
  });
  it("captures batch failure screenshots at the parent flow depth", async () => {
    const handleTool = vi.fn(async (
      name: string,
      _args: Record<string, unknown>,
      _depth?: number,
    ) => {
      if (name === "system_wait") throw new Error("action failed");
      if (name === "screen_capture") {
        return { image: { data: "c2NyZWVu", mimeType: "image/png" } };
      }
      return { text: "ok" };
    });
    const ctx = makeMockContext({ handleTool });

    const result = await handler({
      commands: [{ name: "system_wait" }],
      turbo: true,
    }, ctx, 2);
    expect(result.text).toContain("[screenshot attached]");
    const screenshotCall = handleTool.mock.calls.find(([name]) => name === "screen_capture");
    expect(screenshotCall?.[2]).toBe(3);
  });

  it("returns an incomplete result and aborts a hanging batch action at its deadline", async () => {
    const handleTool = vi.fn(() => new Promise<never>(() => {}));
    const ctx = makeMockContext({ handleTool });

    const result = await handler({
      commands: [{ name: "input_tap" }],
      maxDuration: 10,
    }, ctx);

    expect(result.text).toContain("Batch incomplete");
    expect(handleTool.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
    expect(handleTool.mock.calls[0][3].aborted).toBe(true);
  });
});

// ──────────────────────────────────────────────
// flow_run — security and validation
// ──────────────────────────────────────────────

describe("flow_run", () => {
  const handler = findHandler("flow_run");

  it("enforces recursion depth through tool safety wrappers", async () => {
    const result = await handler(
      { steps: [] },
      makeMockContext(),
      MAX_RECURSION_DEPTH + 1,
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Maximum recursion depth");
  });

  it("throws FLOW_SECURITY for blocked action system_shell", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        steps: [{ action: "system_shell" }],
      }, ctx)
    ).rejects.toThrow(MobileError);

    try {
      await handler({ steps: [{ action: "system_shell" }] }, ctx);
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("FLOW_SECURITY");
      expect((e as MobileError).message).toContain("system_shell");
    }
  });

  it("rejects the legacy shell alias before execution", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        steps: [{ action: "shell", args: { command: "id" } }],
      }, ctx),
    ).rejects.toMatchObject({ code: "FLOW_SECURITY" });
    expect(ctx.handleTool).not.toHaveBeenCalled();
  });
  it("rejects the generic system shell action before execution", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        steps: [{ action: "system", args: { action: "shell", command: "id" } }],
      }, ctx),
    ).rejects.toMatchObject({ code: "FLOW_SECURITY" });
    expect(ctx.handleTool).not.toHaveBeenCalled();
  });

  it("throws ValidationError for empty steps array", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ steps: [] }, ctx)
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for more than 20 steps", async () => {
    const ctx = makeMockContext();
    const steps = Array.from({ length: 21 }, () => ({
      action: "input_tap",
      args: { x: 100, y: 200 },
    }));
    await expect(
      handler({ steps }, ctx)
    ).rejects.toThrow(ValidationError);

    try {
      await handler({ steps }, ctx);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).message).toContain("21");
      expect((e as ValidationError).message).toContain("20");
    }
  });

  it("blocks system_shell among other valid steps", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        steps: [
          { action: "input_tap", args: { x: 100, y: 200 } },
          { action: "system_shell", args: { command: "ls" } },
        ],
      }, ctx)
    ).rejects.toThrow(MobileError);
  });
  it("accepts and forwards a custom registered platform", async () => {
    const ctx = makeMockContext();
    const result = await handler({
      platform: "tizen",
      steps: [{ action: "input_tap", args: { x: 100, y: 200 } }],
    }, ctx);

    expect(result.text).toContain("input_tap");
    expect(ctx.handleTool).toHaveBeenCalledWith(
      "input_tap",
      { platform: "tizen", x: 100, y: 200 },
      1,
      expect.any(AbortSignal),
    );
  });

  it("terminates a hanging nested action at the flow deadline", async () => {
    const handleTool = vi.fn(() => new Promise<unknown>(() => {}));
    const ctx = makeMockContext({ handleTool });

    const result = await handler({
      maxDuration: 10,
      steps: [{ action: "input_tap", args: { x: 10, y: 20 } }],
    }, ctx);

    expect(result.text).toContain("Flow timeout");
    expect(handleTool).toHaveBeenCalledTimes(1);
    expect(handleTool.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
  });

  it("waits for a timed-out turbo ADB action to abort before returning", async () => {
    registerTools([
      {
        tool: { name: "input_text", description: "Type", inputSchema: { type: "object", properties: {} } },
        handler: async () => ({ text: "typed" }),
      },
    ]);
    let aborted = false;
    let cleaned = false;
    const execWithUiDump = vi.fn(
      (_args: readonly string[], _deviceId: string | undefined, signal?: AbortSignal) =>
        new Promise<{ actionOutput: string; uiXml: string }>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            setTimeout(() => {
              cleaned = true;
              reject(signal.reason ?? new Error("aborted"));
            }, 5);
          }, { once: true });
        }),
    );
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ execWithUiDump })),
      } as any,
    });

    const result = await handler({
      maxDuration: 10,
      turbo: true,
      steps: [{ action: "input_text", args: { text: "audit input" } }],
    }, ctx);

    expect(result.text).toContain("Flow timeout");
    expect(execWithUiDump).toHaveBeenCalledOnce();
    expect(aborted).toBe(true);
    expect(cleaned).toBe(true);
  });

  it("bounds failure diagnostics by the total flow deadline", async () => {
    const handleTool = vi.fn(async () => { throw new Error("action failed"); });
    const getElementsForPlatform = vi.fn(
      () => new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 50)),
    );
    const ctx = makeMockContext({ handleTool, getElementsForPlatform });

    const result = await handler({
      maxDuration: 20,
      steps: [{ action: "input_tap", args: { x: 10, y: 20 } }],
    }, ctx);

    expect(result.text).toContain("Flow incomplete");
    expect(result.text).toContain("Action failed");
  });
  it("preserves a failed turbo action without retrying it through the normal tool", async () => {
    const execWithUiDump = vi.fn(async () => {
      throw new Error("turbo tap failed");
    });
    const handleTool = vi.fn(async () => ({ text: "normal tap succeeded" }));
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ execWithUiDump })),
      } as any,
      handleTool,
    });

    const result = await handler({
      turbo: true,
      steps: [{ action: "input_tap", args: { x: 10, y: 20 } }],
    }, ctx);

    expect(result.text).toContain("Action failed");
    expect(result.text).not.toContain("turbo tap failed");
    expect(execWithUiDump).toHaveBeenCalledTimes(1);
    expect(handleTool.mock.calls.filter(([name]) => name === "input_tap")).toHaveLength(0);
  });
  it("captures turbo failure screenshots at the parent flow depth and propagates cancellation", async () => {
    let actionSignal: AbortSignal | undefined;
    const handleTool = vi.fn(async (
      name: string,
      _args: Record<string, unknown>,
      _depth?: number,
      signal?: AbortSignal,
    ) => {
      if (name === "system_wait") {
        actionSignal = signal;
        throw new Error("action failed");
      }
      if (name === "screen_capture") {
        expect(signal).toBe(actionSignal);
        return { image: { data: "c2NyZWVu", mimeType: "image/png" } };
      }
      return { text: "ok" };
    });
    const ctx = makeMockContext({
      handleTool,
      getElementsForPlatform: vi.fn(async () => []),
    });

    const result = await handler(
      {
        turbo: true,
        steps: [{ action: "system_wait" }],
      },
      ctx,
      2,
    );

    expect(result.text).toContain("[screenshot attached]");
    const screenshotCall = handleTool.mock.calls.find(([name]) => name === "screen_capture");
    expect(screenshotCall).toBeDefined();
    expect(screenshotCall?.[2]).toBe(3);
    expect(screenshotCall?.[3]).toBeInstanceOf(AbortSignal);
    expect(screenshotCall?.[3]).toBe(actionSignal);
  });

  it("omits secure-class values from turbo compact UI context", async () => {
    const ctx = makeMockContext({
      getElementsForPlatform: vi.fn(async () => [
        {
          index: 0,
          resourceId: "password",
          className: "XCUIElementTypeSecureTextField",
          packageName: "",
          text: "super-secret",
          contentDesc: "Password",
          checkable: false,
          checked: false,
          clickable: true,
          enabled: true,
          focusable: true,
          focused: true,
          scrollable: false,
          longClickable: false,
          password: false,
          selected: false,
          bounds: { x1: 0, y1: 0, x2: 100, y2: 40 },
          centerX: 50,
          centerY: 20,
          width: 100,
          height: 40,
        },
        {
          index: 1,
          resourceId: "continue",
          className: "android.widget.Button",
          packageName: "",
          text: "Continue",
          contentDesc: "",
          checkable: false,
          checked: false,
          clickable: true,
          enabled: true,
          focusable: true,
          focused: false,
          scrollable: false,
          longClickable: false,
          password: false,
          selected: false,
          bounds: { x1: 0, y1: 50, x2: 100, y2: 90 },
          centerX: 50,
          centerY: 70,
          width: 100,
          height: 40,
        },
      ]),
    });

    const result = await handler({
      turbo: true,
      steps: [{ action: "system_wait" }],
    }, ctx);

    expect(result.text).toContain('Button "Continue"');
    expect(result.text).not.toContain("super-secret");
    expect(result.text).not.toContain("Password");
  });
});

// ──────────────────────────────────────────────
// flow_parallel — security and validation
// ──────────────────────────────────────────────

describe("flow_parallel", () => {
  const handler = findHandler("flow_parallel");

  it("throws FLOW_SECURITY for blocked action system_shell", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        action: "system_shell",
        devices: ["emulator-5554"],
        args: { command: "ls" },
      }, ctx)
    ).rejects.toThrow(MobileError);

    try {
      await handler({
        action: "system_shell",
        devices: ["emulator-5554"],
        args: { command: "ls" },
      }, ctx);
    } catch (e) {
      expect(e).toBeInstanceOf(MobileError);
      expect((e as MobileError).code).toBe("FLOW_SECURITY");
      expect((e as MobileError).message).toContain("system_shell");
    }
  });

  it("rejects the legacy shell alias before execution", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        action: "shell",
        devices: ["emulator-5554"],
        args: { command: "id" },
      }, ctx),
    ).rejects.toMatchObject({ code: "FLOW_SECURITY" });
    expect(ctx.handleTool).not.toHaveBeenCalled();
  });

  it("rejects the generic system shell action before execution", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({
        action: "system",
        devices: ["emulator-5554"],
        args: { action: "shell", command: "id" },
      }, ctx),
    ).rejects.toMatchObject({ code: "FLOW_SECURITY" });
    expect(ctx.handleTool).not.toHaveBeenCalled();
  });

  it("throws ValidationError for empty devices array", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ action: "input_tap", devices: [] }, ctx)
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for more than 10 devices", async () => {
    const ctx = makeMockContext();
    const devices = Array.from({ length: 11 }, (_, i) => `device-${i}`);
    await expect(
      handler({ action: "input_tap", devices }, ctx)
    ).rejects.toThrow(ValidationError);
  });

  it("accepts valid action on multiple devices", async () => {
    const ctx = makeMockContext();
    const result = await handler({
      action: "input_tap",
      devices: ["emulator-5554", "emulator-5556"],
      args: { x: 100, y: 200 },
    }, ctx);
    expect(result).toBeDefined();
    expect((result as any).text).toContain("input_tap");
  });
  it("labels failed results with the requested device id", async () => {
    const ctx = makeMockContext({
      handleTool: vi.fn(async () => { throw new Error("Device not found"); }),
    });

    const result = await handler({
      action: "input_tap",
      devices: ["???"],
    }, ctx);

    expect(result.text).toContain("Action failed");
    expect(result.text).not.toContain("Device not found");
  });

  it("returns an incomplete result and aborts hanging parallel actions", async () => {
    const handleTool = vi.fn(() => new Promise<never>(() => {}));
    const ctx = makeMockContext({ handleTool });

    const result = await handler({
      action: "input_tap",
      devices: ["device-a", "device-b"],
      maxDuration: 10,
    }, ctx);

    expect(result.text).toContain("incomplete (max duration exceeded)");
    expect(result.text).toContain("device-a");
    expect(result.text).toContain("device-b");
    expect(handleTool).toHaveBeenCalledTimes(2);
    expect(handleTool.mock.calls[0][3]).toBeInstanceOf(AbortSignal);
    expect(handleTool.mock.calls[0][3].aborted).toBe(true);
  });
});

describe("flow nested result redaction", () => {
  it("keeps nested result text, values, and errors out of flow outputs", async () => {
    const resultSecret = "FLOW_NESTED_RESULT_SECRET_7f3e";
    const errorSecret = "FLOW_NESTED_ERROR_SECRET_91c2";
    const actionResult = { text: resultSecret, value: resultSecret };
    const successContext = makeMockContext({
      handleTool: vi.fn(async () => actionResult),
    });

    const successOutputs = await Promise.all([
      findHandler("flow_batch")({ commands: [{ name: "input_tap" }] }, successContext),
      findHandler("flow_run")({ steps: [{ action: "input_tap" }] }, successContext),
      findHandler("flow_parallel")({ action: "input_tap", devices: ["device-a"] }, successContext),
    ]) as Array<{ text: string }>;

    expect(successOutputs[0].text).toContain("OK");
    expect(successOutputs[1].text).toContain("OK");
    expect(successOutputs[2].text).toContain("1/1 OK");
    for (const output of successOutputs) {
      expect(output.text).not.toContain(resultSecret);
      expect(output.text).not.toContain(errorSecret);
    }

    const failureContext = makeMockContext({
      handleTool: vi.fn(async () => {
        throw new Error(errorSecret);
      }),
    });
    const failureOutputs = await Promise.all([
      findHandler("flow_batch")({ commands: [{ name: "input_tap" }] }, failureContext),
      findHandler("flow_run")({ steps: [{ action: "input_tap" }] }, failureContext),
      findHandler("flow_parallel")({ action: "input_tap", devices: ["device-a"] }, failureContext),
    ]) as Array<{ text: string }>;

    expect(failureOutputs[0].text).toContain("ERROR");
    expect(failureOutputs[1].text).toContain("FAIL");
    expect(failureOutputs[2].text).toContain("FAIL");
    for (const output of failureOutputs) {
      expect(output.text).not.toContain(resultSecret);
      expect(output.text).not.toContain(errorSecret);
    }
  });

  it("sanitizes caller-provided flow result messages during formatting", () => {
    const secret = "FLOW_FORMATTER_MESSAGE_SECRET_2a8d";
    const output = formatFlowResults([
      {
        step: 1,
        action: "input_tap",
        success: false,
        message: secret,
        durationMs: 1,
      },
    ], 1);

    expect(output).toContain("FAIL");
    expect(output).toContain("Action failed");
    expect(output).not.toContain(secret);
  });
});

describe("flow parent cancellation", () => {
  const cases: Array<{
    name: string;
    args: Record<string, unknown>;
    output: string;
  }> = [
    {
      name: "flow_run",
      args: { steps: [{ action: "input_tap", on_error: "retry", repeat: { times: 3 } }] },
      output: "Flow cancelled",
    },
    {
      name: "flow_batch",
      args: { commands: [{ name: "input_tap" }, { name: "system_wait" }] },
      output: "Batch cancelled",
    },
    {
      name: "flow_parallel",
      args: { action: "input_tap", devices: ["device-a"] },
      output: "Parallel cancelled",
    },
  ];

  it.each(cases)("does not start $name after parent abort", async ({ name, args, output }) => {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeMockContext({ signal: controller.signal });

    const result = await findHandler(name)(args, ctx) as { text: string };

    expect(result.text).toContain(output);
    expect(ctx.handleTool).not.toHaveBeenCalled();
  });

  it.each(cases)("stops $name and later work after parent abort", async ({ name, args, output }) => {
    const controller = new AbortController();
    let actionSignal: AbortSignal | undefined;
    const handleTool = vi.fn((
      _name: string,
      _args: Record<string, unknown>,
      _depth?: number,
      signal?: AbortSignal,
    ) => {
      actionSignal = signal;
      controller.abort();
      return new Promise<never>(() => {});
    });
    const ctx = makeMockContext({ handleTool, signal: controller.signal });

    const result = await findHandler(name)(args, ctx) as { text: string };

    expect(result.text).toContain(output);
    expect(actionSignal).toBeInstanceOf(AbortSignal);
    expect(actionSignal?.aborted).toBe(true);
    expect(handleTool).toHaveBeenCalledTimes(1);
  });
});
