import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { captureStep, isRecording, recorderTools } from "./recorder-tools.js";
import type { ToolContext } from "./context.js";
import { RecorderAlreadyActiveError, RecorderNotActiveError } from "../errors.js";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// Minimal mock context
function mockCtx(tempDir: string): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: () => "android",
      cleanup: async () => {},
    } as any,
    getCachedElements: () => [],
    setCachedElements: () => {},
    lastScreenshotMap: new Map(),
    lastUiTreeMap: new Map(),
    screenshotScaleMap: new Map(),
    generateActionHints: async () => "",
    getElementsForPlatform: async () => [],
    iosTreeToUiElements: () => [],
    formatIOSUITree: () => "",
    platformParam: { type: "string", enum: ["android"], description: "" },
    handleTool: async () => ({ text: "ok" }),
  };
}

let tempDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "recorder-test-"));
  process.env.CLAUDE_MOBILE_SCENARIOS_DIR = join(tempDir, ".test-scenarios");
  ctx = mockCtx(tempDir);
});

afterEach(async () => {
  // Ensure recording is stopped
  const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;
  try { await stopHandler({ discard: true }, ctx); } catch { /* not active — ok */ }
  delete process.env.CLAUDE_MOBILE_SCENARIOS_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

// ── captureStep ──

describe("captureStep", () => {
  it("does nothing when not recording", () => {
    expect(isRecording()).toBe(false);
    captureStep("input_tap", { text: "Login" }, 0);
    // No error, just no-op
  });

  it("ignores depth > 0", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    await startHandler({ name: "test", platform: "android" }, ctx);

    captureStep("input_tap", { text: "A" }, 0); // captured
    captureStep("input_tap", { text: "B" }, 1); // ignored

    const statusHandler = recorderTools.find(t => t.tool.name === "recorder_status")!.handler;
    const result = await statusHandler({}, ctx) as { text: string };
    expect(result.text).toContain("Steps: 1");
  });

  it("ignores blocklisted actions", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    await startHandler({ name: "test", platform: "android" }, ctx);

    captureStep("system_shell", { command: "ls" }, 0); // blocked
    captureStep("recorder_start", { name: "x" }, 0); // blocked
    captureStep("flow_run", { steps: [] }, 0); // blocked
    captureStep("input_tap", { text: "Login" }, 0); // allowed

    const statusHandler = recorderTools.find(t => t.tool.name === "recorder_status")!.handler;
    const result = await statusHandler({}, ctx) as { text: string };
    expect(result.text).toContain("Steps: 1");
  });
});

// ── start ──

describe("recorder_start", () => {
  it("starts recording", async () => {
    const handler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const result = await handler({ name: "login-flow", platform: "android" }, ctx) as { text: string };
    expect(result.text).toContain("Recording started");
    expect(isRecording()).toBe(true);
  });

  it("rejects if already recording", async () => {
    const handler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    await handler({ name: "first", platform: "android" }, ctx);
    await expect(handler({ name: "second", platform: "android" }, ctx)).rejects.toThrow(RecorderAlreadyActiveError);
  });
});

// ── stop ──

describe("recorder_stop", () => {
  it("saves recording", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;

    await startHandler({ name: "login", platform: "android" }, ctx);
    captureStep("input_tap", { text: "Login" }, 0);
    const result = await stopHandler({}, ctx) as { text: string };
    expect(result.text).toContain("Recording saved");
    expect(result.text).toContain("1 steps");
    expect(isRecording()).toBe(false);
  });

  it("discards when flag set", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;

    await startHandler({ name: "discard-test", platform: "android" }, ctx);
    captureStep("input_tap", { text: "X" }, 0);
    const result = await stopHandler({ discard: true }, ctx) as { text: string };
    expect(result.text).toContain("discarded");
    expect(isRecording()).toBe(false);
  });

  it("throws if not recording", async () => {
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;
    await expect(stopHandler({}, ctx)).rejects.toThrow(RecorderNotActiveError);
  });
});

// ── status ──

describe("recorder_status", () => {
  it("returns idle when not recording", async () => {
    const handler = recorderTools.find(t => t.tool.name === "recorder_status")!.handler;
    const result = await handler({}, ctx) as { text: string };
    expect(result.text).toContain("No recording");
  });

  it("returns state when recording", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const statusHandler = recorderTools.find(t => t.tool.name === "recorder_status")!.handler;

    await startHandler({ name: "test", platform: "android" }, ctx);
    captureStep("input_tap", { text: "A" }, 0);

    const result = await statusHandler({}, ctx) as { text: string };
    expect(result.text).toContain("test");
    expect(result.text).toContain("Steps: 1");
  });
});

// ── add_step / remove_step ──

describe("add_step / remove_step", () => {
  it("adds and removes steps", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const addHandler = recorderTools.find(t => t.tool.name === "recorder_add_step")!.handler;
    const removeHandler = recorderTools.find(t => t.tool.name === "recorder_remove_step")!.handler;
    const statusHandler = recorderTools.find(t => t.tool.name === "recorder_status")!.handler;

    await startHandler({ name: "test", platform: "android" }, ctx);

    await addHandler({ action_name: "ui_assert_visible", args: { text: "Welcome" }, label: "check" }, ctx);
    let status = await statusHandler({}, ctx) as { text: string };
    expect(status.text).toContain("Steps: 1");

    await removeHandler({ stepIndex: 1 }, ctx);
    status = await statusHandler({}, ctx) as { text: string };
    expect(status.text).toContain("Steps: 0");
  });

  it("throws if not recording", async () => {
    const addHandler = recorderTools.find(t => t.tool.name === "recorder_add_step")!.handler;
    await expect(addHandler({ action_name: "input_tap" }, ctx)).rejects.toThrow(RecorderNotActiveError);
  });
});

// ── Sensitive input detection ──

describe("sensitive input", () => {
  it("redacts password-like inputs", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;
    const showHandler = recorderTools.find(t => t.tool.name === "recorder_show")!.handler;

    await startHandler({ name: "redact-test", platform: "android" }, ctx);
    captureStep("input_text", { text: "mypassword123", resourceId: "password_field" }, 0);
    await stopHandler({}, ctx);

    // Show scenario — password should be redacted
    const result = await showHandler({ name: "redact-test", platform: "android" }, ctx) as { text: string };
    expect(result.text).not.toContain("mypassword123");
    expect(result.text).toContain("[REDACTED]");
  });
});

// ── Step classification ──

describe("step classification", () => {
  it("classifies step types correctly", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const showHandler = recorderTools.find(t => t.tool.name === "recorder_show")!.handler;
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;

    await startHandler({ name: "classify-test", platform: "android" }, ctx);
    captureStep("input_tap", { text: "Button" }, 0);
    captureStep("input_text", { text: "hello" }, 0);
    captureStep("system_wait", { ms: 1000 }, 0);
    captureStep("app_launch", { package: "com.test" }, 0);
    captureStep("visual_compare", { name: "baseline" }, 0);
    await stopHandler({}, ctx);

    const result = await showHandler({ name: "classify-test", platform: "android" }, ctx) as { text: string };
    expect(result.text).toContain("[gesture]"); // input_tap
    expect(result.text).toContain("[data_input]"); // input_text
    expect(result.text).toContain("[wait]"); // system_wait
    expect(result.text).toContain("[navigate]"); // app_launch
    expect(result.text).toContain("[visual]"); // visual_compare
  });
});
