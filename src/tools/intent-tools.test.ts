import { describe, it, expect, vi, beforeEach } from "vitest";
import { intentTools } from "./intent-tools.js";
import { ValidationError, MobileError } from "../errors.js";
import type { ToolContext } from "./context.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findHandler(name: string) {
  const def = intentTools.find((t) => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found`);
  return def.handler;
}

function makeMockContext(overrides?: Partial<ToolContext>): ToolContext {
  // Create stable client objects so every getAndroidClient()/getIosClient() call
  // returns the exact same mock instance — this lets captureShellCommand inspect
  // calls accumulated across handler execution.
  const androidClient = {
    shell: vi.fn(() => ""),
    exec: vi.fn(() => ""),
  };
  const iosClient = {
    openUrl: vi.fn(),
  };
  const shell = vi.fn((_cmd: string, _platform?: string, _deviceId?: string) => "");

  return {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "android"),
      getAndroidClient: vi.fn(() => androidClient),
      getIosClient: vi.fn(() => iosClient),
      shell,
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
    invalidateUiTreeCache: vi.fn(),
    platformParam: {
      type: "string",
      enum: ["android", "ios", "desktop"],
      description: "",
    },
    handleTool: vi.fn(async () => ({ text: "ok" })),
    ...overrides,
  };
}

/** Pull the last shell() call's first argument from the deviceManager mock */
function captureShellCommand(ctx: ToolContext): string {
  const shellMock = ctx.deviceManager.shell as unknown as ReturnType<typeof vi.fn>;
  const calls = shellMock.mock.calls;
  if (calls.length === 0) throw new Error("shell() was never called");
  return calls[calls.length - 1][0] as string;
}

// ─── intent_start ─────────────────────────────────────────────────────────────

describe("intent_start", () => {
  const handler = findHandler("intent_start");

  it("returns iOS redirect message when platform=ios", async () => {
    const ctx = makeMockContext();
    const result = await handler({ platform: "ios" }, ctx);
    expect((result as any).text).toMatch(/iOS does not support Android-style intent/i);
    expect((result as any).text).toMatch(/intent_deeplink/i);
  });

  it("returns unsupported message for desktop platform", async () => {
    const ctx = makeMockContext();
    const result = await handler({ platform: "desktop" }, ctx);
    expect((result as any).text).toMatch(/intent_start is only supported on Android/i);
    expect((result as any).text).toMatch(/desktop/);
  });

  it("calls `am start` with intentAction via -a flag", async () => {
    const ctx = makeMockContext();
    await handler({ intentAction: "android.intent.action.VIEW" }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toBe("am start -a android.intent.action.VIEW");
  });

  it("calls `am start` with component via -n flag", async () => {
    const ctx = makeMockContext();
    await handler({ component: "com.example.app/com.example.app.MainActivity" }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toBe("am start -n com.example.app/com.example.app.MainActivity");
  });

  it("calls `am start` with data URI via -d flag", async () => {
    const ctx = makeMockContext();
    await handler({ data: "https://example.com/path" }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("-d 'https://example.com/path'");
  });

  it("calls `am start` with category via -c flag", async () => {
    const ctx = makeMockContext();
    await handler({ category: "android.intent.category.DEFAULT" }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("-c android.intent.category.DEFAULT");
  });

  it("calls `am start` with package via -p flag", async () => {
    const ctx = makeMockContext();
    await handler({ package: "com.example.app" }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("-p com.example.app");
  });

  it("includes string extra with --es flag", async () => {
    const ctx = makeMockContext();
    await handler({ extras: [{ key: "myKey", value: "hello" }] }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("--es myKey hello");
  });

  it("includes integer extra with --ei flag (inferred from integer value)", async () => {
    const ctx = makeMockContext();
    await handler({ extras: [{ key: "count", value: 42 }] }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("--ei count 42");
  });

  it("includes boolean extra with --ez flag (inferred from boolean value)", async () => {
    const ctx = makeMockContext();
    await handler({ extras: [{ key: "flag", value: true }] }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("--ez flag true");
  });

  it("includes float extra with --ef flag (inferred from non-integer number)", async () => {
    const ctx = makeMockContext();
    await handler({ extras: [{ key: "ratio", value: 3.14 }] }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("--ef ratio 3.14");
  });

  it("includes multiple extras of different types in a single command", async () => {
    const ctx = makeMockContext();
    await handler({
      extras: [
        { key: "name", value: "Alice" },
        { key: "age", value: 30 },
        { key: "active", value: false },
        { key: "score", value: 9.5 },
      ],
    }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("--es name Alice");
    expect(cmd).toContain("--ei age 30");
    expect(cmd).toContain("--ez active false");
    expect(cmd).toContain("--ef score 9.5");
  });

  it("combines FLAG_ACTIVITY_NEW_TASK and FLAG_ACTIVITY_CLEAR_TOP with bitwise OR into single -f hex value", async () => {
    const ctx = makeMockContext();
    await handler({
      flags: ["FLAG_ACTIVITY_NEW_TASK", "FLAG_ACTIVITY_CLEAR_TOP"],
    }, ctx);
    const cmd = captureShellCommand(ctx);
    // 0x10000000 | 0x04000000 = 0x14000000
    expect(cmd).toContain("-f 0x14000000");
  });

  it("handles a single flag correctly", async () => {
    const ctx = makeMockContext();
    await handler({ flags: ["FLAG_ACTIVITY_SINGLE_TOP"] }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("-f 0x20000000");
  });

  it("rejects invalid intentAction containing semicolon", async () => {
    const ctx = makeMockContext();
    await expect(handler({ intentAction: "bad;action" }, ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects intentAction starting with a digit", async () => {
    const ctx = makeMockContext();
    await expect(handler({ intentAction: "1invalid.action" }, ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects invalid component missing slash separator", async () => {
    const ctx = makeMockContext();
    await expect(handler({ component: "com.example.app" }, ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects invalid package name with hyphen", async () => {
    const ctx = makeMockContext();
    // validatePackageName throws MobileError (base class); it is intentionally
    // not a ValidationError since it originates from the sanitize utility layer.
    await expect(handler({ package: "com.bad-package" }, ctx)).rejects.toBeInstanceOf(MobileError);
  });

  it("uses getCurrentPlatform() when no platform arg provided", async () => {
    const ctx = makeMockContext();
    (ctx.deviceManager.getCurrentPlatform as ReturnType<typeof vi.fn>).mockReturnValue("android");
    await handler({ intentAction: "android.intent.action.MAIN" }, ctx);
    expect(ctx.deviceManager.getCurrentPlatform).toHaveBeenCalled();
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("am start");
  });

  it("returns text containing shell output when shell returns non-empty string", async () => {
    const ctx = makeMockContext();
    (ctx.deviceManager.shell as ReturnType<typeof vi.fn>).mockReturnValue(
      "Starting: Intent { act=android.intent.action.VIEW }",
    );
    const result = await handler({ intentAction: "android.intent.action.VIEW" }, ctx);
    expect((result as any).text).toContain("Starting");
  });
});

// ─── intent_broadcast ─────────────────────────────────────────────────────────

describe("intent_broadcast", () => {
  const handler = findHandler("intent_broadcast");

  it("returns error message for iOS platform", async () => {
    const ctx = makeMockContext();
    const result = await handler({ intentAction: "com.example.MY_EVENT", platform: "ios" }, ctx);
    expect((result as any).text).toMatch(/intent_broadcast is Android-only/i);
  });

  it("calls `am broadcast -a <action>` with correct action", async () => {
    const ctx = makeMockContext();
    await handler({ intentAction: "android.intent.action.BOOT_COMPLETED" }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toBe("am broadcast -a android.intent.action.BOOT_COMPLETED");
  });

  it("includes extras in broadcast command", async () => {
    const ctx = makeMockContext();
    await handler({
      intentAction: "com.example.EVENT",
      extras: [{ key: "payload", value: "data" }],
    }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("am broadcast -a com.example.EVENT");
    expect(cmd).toContain("--es payload data");
  });

  it("includes package filter -p in broadcast command", async () => {
    const ctx = makeMockContext();
    await handler({
      intentAction: "com.example.EVENT",
      package: "com.example.app",
    }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("-p com.example.app");
  });

  it("includes explicit component -n in broadcast command", async () => {
    const ctx = makeMockContext();
    await handler({
      intentAction: "com.example.EVENT",
      component: "com.example.app/com.example.app.MyReceiver",
    }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("-n com.example.app/com.example.app.MyReceiver");
  });

  it("rejects invalid action with special characters", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ intentAction: "invalid action!" }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects invalid package name in broadcast", async () => {
    const ctx = makeMockContext();
    // validatePackageName throws MobileError (base class), not ValidationError
    await expect(
      handler({ intentAction: "com.example.EVENT", package: "invalid package" }, ctx),
    ).rejects.toBeInstanceOf(MobileError);
  });
});

// ─── intent_deeplink ──────────────────────────────────────────────────────────

describe("intent_deeplink", () => {
  const handler = findHandler("intent_deeplink");

  it("opens deep link on Android using `am start -a android.intent.action.VIEW -d`", async () => {
    const ctx = makeMockContext();
    await handler({ uri: "https://example.com/path" }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("am start");
    expect(cmd).toContain("-a android.intent.action.VIEW");
    expect(cmd).toContain("-d 'https://example.com/path'");
  });

  it("opens deep link on iOS using getIosClient().openUrl()", async () => {
    const openUrlMock = vi.fn();
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        getIosClient: vi.fn(() => ({ openUrl: openUrlMock })),
        shell: vi.fn(() => ""),
      } as any,
    });
    await handler({ uri: "myapp://screen/details", platform: "ios" }, ctx);
    expect(openUrlMock).toHaveBeenCalledWith("myapp://screen/details");
  });

  it("includes -p package filter on Android deep link", async () => {
    const ctx = makeMockContext();
    await handler({ uri: "https://example.com", package: "com.example.app" }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("-p com.example.app");
  });

  it("returns unsupported message for desktop platform", async () => {
    const ctx = makeMockContext();
    const result = await handler({ uri: "https://example.com", platform: "desktop" }, ctx);
    expect((result as any).text).toMatch(/intent_deeplink is only supported on Android and iOS/i);
    expect((result as any).text).toMatch(/desktop/);
  });

  it("throws ValidationError for empty URI", async () => {
    const ctx = makeMockContext();
    // sanitizeForShell strips all special chars; an empty string will fail the length check
    await expect(handler({ uri: "" }, ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ValidationError for URI consisting only of blocked characters", async () => {
    const ctx = makeMockContext();
    // All chars stripped by sanitizeForShell: backtick, dollar, backslash, etc.
    await expect(handler({ uri: "`$\\!#" }, ctx)).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates package name if provided on Android deep link", async () => {
    const ctx = makeMockContext();
    await expect(
      handler({ uri: "https://example.com", package: "bad package!" }, ctx),
    ).rejects.toBeInstanceOf(Error);
  });

  it("returns success text with URI for iOS", async () => {
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        getIosClient: vi.fn(() => ({ openUrl: vi.fn() })),
        shell: vi.fn(() => ""),
      } as any,
    });
    const result = await handler({ uri: "myapp://home", platform: "ios" }, ctx);
    expect((result as any).text).toContain("myapp://home");
  });

  it("passes custom scheme deep link on Android correctly", async () => {
    const ctx = makeMockContext();
    await handler({ uri: "myapp://product/42" }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toContain("-d 'myapp://product/42'");
  });
});

// ─── intent_services ──────────────────────────────────────────────────────────

describe("intent_services", () => {
  const handler = findHandler("intent_services");

  it("returns error message for iOS platform", async () => {
    const ctx = makeMockContext();
    const result = await handler({ platform: "ios" }, ctx);
    expect((result as any).text).toMatch(/intent_services is Android-only/i);
  });

  it("calls `dumpsys activity services` without package when none provided", async () => {
    const ctx = makeMockContext();
    await handler({}, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toBe("dumpsys activity services");
  });

  it("calls `dumpsys activity services <pkg>` when package is provided", async () => {
    const ctx = makeMockContext();
    await handler({ package: "com.example.app" }, ctx);
    const cmd = captureShellCommand(ctx);
    expect(cmd).toBe("dumpsys activity services com.example.app");
  });

  it("parses ServiceRecord blocks and returns them in output", async () => {
    const dumpOutput = [
      "ACTIVITY MANAGER SERVICES (dumpsys activity services)",
      "  User 0 active services:",
      "ServiceRecord{abc123 u0 com.example.app/.MyService}",
      "  intent={act=com.example.INTENT}",
      "  app=ProcessRecord{def456 1234:com.example.app/u0a99}",
      "  running=true",
      "",
      "",
      "",
    ].join("\n");

    const shellMock = vi.fn(() => dumpOutput);
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        getIosClient: vi.fn(() => ({ openUrl: vi.fn() })),
        shell: shellMock,
      } as any,
    });

    const result = await handler({}, ctx);
    const text = (result as any).text as string;
    expect(text).toContain("ServiceRecord{abc123 u0 com.example.app/.MyService}");
    expect(text).toContain("intent=");
    expect(text).toContain("app=");
    expect(text).toContain("running=true");
  });

  it("returns 'no running services' message when output has no ServiceRecord blocks", async () => {
    const shellMock = vi.fn(() => "ACTIVITY MANAGER SERVICES\n  No services running.\n");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        getIosClient: vi.fn(() => ({ openUrl: vi.fn() })),
        shell: shellMock,
      } as any,
    });

    const result = await handler({}, ctx);
    expect((result as any).text).toMatch(/No running services found/i);
  });

  it("returns package-specific 'no services' message when package provided but nothing found", async () => {
    const shellMock = vi.fn(() => "");
    const ctx = makeMockContext({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getAndroidClient: vi.fn(() => ({ shell: vi.fn(() => "") })),
        getIosClient: vi.fn(() => ({ openUrl: vi.fn() })),
        shell: shellMock,
      } as any,
    });

    const result = await handler({ package: "com.example.app" }, ctx);
    expect((result as any).text).toContain("com.example.app");
  });

  it("rejects invalid package name in intent_services", async () => {
    const ctx = makeMockContext();
    await expect(handler({ package: "bad-pkg!" }, ctx)).rejects.toBeInstanceOf(Error);
  });
});
