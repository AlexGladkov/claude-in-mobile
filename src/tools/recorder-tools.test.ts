import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { captureStep, isRecording, recorderTools } from "./recorder-tools.js";
import { executePlayback, formatPlaybackResults } from "./recorder/playback.js";
import { redactSensitiveArgs } from "./recorder/redaction.js";
import type { Scenario } from "../utils/scenario-store.js";
import { ScenarioStore } from "../utils/scenario-store.js";
import type { ToolContext } from "./context.js";
import { RecorderAlreadyActiveError, RecorderNotActiveError, ValidationError } from "../errors.js";
import { registerTools } from "./registry.js";
import { mkdtemp, rm, writeFile } from "fs/promises";
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

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "recorder-test-"));
  process.env.CLAUDE_MOBILE_SCENARIOS_DIR = join(tempDir, ".test-scenarios");
});

beforeEach(async () => {
  await rm(join(tempDir, ".test-scenarios"), { recursive: true, force: true });
  ctx = mockCtx(tempDir);
});

afterEach(async () => {
  // Ensure recording is stopped
  const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;
  try { await stopHandler({ discard: true }, ctx); } catch { /* not active — ok */ }
  await rm(join(tempDir, ".test-scenarios"), { recursive: true, force: true });
});

afterAll(async () => {
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
    captureStep("debug_eval", { expression: "1 + 1" }, 0); // blocked
    captureStep("debug_set_var", { name: "value", value: "changed" }, 0); // blocked
    captureStep("repl_spawn", { cmd: "env TOKEN=launch-secret run" }, 0); // blocked
    captureStep("app_install", { path: "/tmp/app.apk" }, 0); // blocked
    captureStep("system_file_push", { localPath: "secret.bin" }, 0); // blocked
    captureStep("install_app", { path: "/tmp/app.apk" }, 0); // blocked
    captureStep("push_file", { localPath: "secret.bin" }, 0); // blocked
    captureStep("app", { action: "install", path: "/tmp/app.apk" }, 0); // blocked
    captureStep("app_uninstall", { package: "com.example.app" }, 0); // blocked
    captureStep("uninstall_app", { package: "com.example.app" }, 0); // blocked
    captureStep("app", { action: "uninstall", package: "com.example.app" }, 0); // blocked
    captureStep("system", { action: "file_push", localPath: "secret.bin" }, 0); // blocked
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

  it("reserves the recorder slot before asynchronous scenario checks", async () => {
    const handler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const outcomes = await Promise.allSettled([
      handler({ name: "first-race", platform: "android" }, ctx),
      handler({ name: "second-race", platform: "android" }, ctx),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason)
      .toBeInstanceOf(RecorderAlreadyActiveError);
    expect(isRecording()).toBe(true);
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

  it("retains a recording after a failed save so it can be retried", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;
    const scenariosDir = join(tempDir, ".test-scenarios");

    await startHandler({ name: "retry-save", platform: "android" }, ctx);
    captureStep("input_tap", { text: "Retry" }, 0);

    await rm(scenariosDir, { recursive: true, force: true });
    await writeFile(scenariosDir, "not a directory");
    await expect(stopHandler({}, ctx)).rejects.toThrow();

    expect(isRecording()).toBe(true);
    const statusHandler = recorderTools.find(t => t.tool.name === "recorder_status")!.handler;
    const status = await statusHandler({}, ctx) as { text: string };
    expect(status.text).toContain("Steps: 1");

    await rm(scenariosDir, { force: true });
    const retryResult = await stopHandler({}, ctx) as { text: string };
    expect(retryResult.text).toContain("Recording saved");
    expect(isRecording()).toBe(false);

    const saved = await new ScenarioStore(tempDir).get("retry-save", "android");
    expect(saved.steps).toHaveLength(1);
    expect(saved.steps[0].args).toEqual({ text: "Retry" });
  });

  it("freezes the recording while saving and rejects concurrent stop/start", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;
    let resolveSaveStarted: () => void = () => {};
    let releaseSave: () => void = () => {};
    const saveStarted = new Promise<void>((resolve) => { resolveSaveStarted = resolve; });
    const saveReleased = new Promise<void>((resolve) => { releaseSave = resolve; });
    let savedScenario: Scenario | undefined;
    const originalSave = ScenarioStore.prototype.save;
    const saveSpy = vi.spyOn(ScenarioStore.prototype, "save").mockImplementation(async function (
      this: ScenarioStore,
      scenario: Scenario,
      options?: { overwrite?: boolean },
    ) {
      savedScenario = scenario;
      resolveSaveStarted();
      await saveReleased;
      return originalSave.call(this, scenario, options);
    });
    let stopPromise: Promise<unknown> | undefined;

    try {
      await startHandler({ name: "save-guard", platform: "android" }, ctx);
      captureStep("input_tap", { text: "Before save" }, 0);
      stopPromise = stopHandler({}, ctx);
      await saveStarted;

      captureStep("input_tap", { text: "During save" }, 0);
      expect(savedScenario?.steps.map(step => step.args.text)).toEqual(["Before save"]);
      expect(isRecording()).toBe(true);
      await expect(stopHandler({}, ctx)).rejects.toMatchObject({ code: "RECORDER_SAVE_IN_PROGRESS" });
      await expect(startHandler({ name: "replacement", platform: "android" }, ctx))
        .rejects.toThrow(RecorderAlreadyActiveError);

      releaseSave();
      await stopPromise;
      expect(savedScenario?.steps).toHaveLength(1);
      expect(isRecording()).toBe(false);
    } finally {
      releaseSave();
      if (stopPromise) await stopPromise.catch(() => {});
      saveSpy.mockRestore();
    }
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
  it("rejects install, uninstall, and file-push actions before persistence", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const addHandler = recorderTools.find(t => t.tool.name === "recorder_add_step")!.handler;
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;
    const blocked: Array<{ action_name: string; args: Record<string, unknown> }> = [
      { action_name: "app_install", args: { path: "/tmp/app.apk" } },
      { action_name: "system_file_push", args: { localPath: "secret.bin" } },
      { action_name: "install_app", args: { path: "/tmp/app.apk" } },
      { action_name: "app_uninstall", args: { package: "com.example.app" } },
      { action_name: "uninstall_app", args: { package: "com.example.app" } },
      { action_name: "app", args: { action: "uninstall", package: "com.example.app" } },
      { action_name: "push_file", args: { localPath: "secret.bin" } },
      { action_name: "app", args: { action: "install", path: "/tmp/app.apk" } },
      { action_name: "system", args: { action: "file_push", localPath: "secret.bin" } },
      { action_name: "debug_eval", args: { expression: "1 + 1" } },
      { action_name: "debug_set_var", args: { name: "value", value: "changed" } },
      { action_name: "repl_spawn", args: { cmd: "env TOKEN=manual-secret run" } },
    ];

    await startHandler({ name: "blocked-device-actions", platform: "android" }, ctx);
    for (const args of blocked) {
      await expect(addHandler(args, ctx)).rejects.toMatchObject({ code: "SCENARIO_ACTION_BLOCKED" });
    }

    const statusHandler = recorderTools.find(t => t.tool.name === "recorder_status")!.handler;
    const status = await statusHandler({}, ctx) as { text: string };
    expect(status.text).toContain("Steps: 0");

    await stopHandler({}, ctx);
    const saved = await new ScenarioStore().get("blocked-device-actions", "android");
    expect(saved.steps).toHaveLength(0);
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
  it("redacts ordinary typed input because the focused field may be sensitive", () => {
    const result = redactSensitiveArgs("input_text", { text: "hunter2!" });

    expect(result).toEqual({
      args: { text: "[REDACTED]" },
      sensitive: true,
    });
  });

  
  it("redacts REPL commands and clipboard payloads before persistence and display", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;
    const showHandler = recorderTools.find(t => t.tool.name === "recorder_show")!.handler;
    const replCommand = "export TOKEN=private-repl-command";
    const clipboardText = "private-clipboard-content";
    const aliasClipboardText = "private-desktop-clipboard-content";

    await startHandler({ name: "sensitive-text-actions", platform: "android" }, ctx);
    captureStep("repl_send", { id: "session-1", text: replCommand }, 0);
    captureStep("clipboard_set", { text: clipboardText }, 0);
    captureStep("desktop", { action: "clipboard_set", text: aliasClipboardText }, 0);
    await stopHandler({}, ctx);

    const saved = await new ScenarioStore().get("sensitive-text-actions", "android");
    const shown = await showHandler({ name: "sensitive-text-actions", platform: "android" }, ctx) as { text: string };
    const output = `${JSON.stringify(saved)}\n${shown.text}`;

    for (const secret of [replCommand, clipboardText, aliasClipboardText]) {
      expect(output).not.toContain(secret);
    }
    expect(saved.steps).toHaveLength(3);
    expect(saved.steps.map(step => step.sensitive)).toEqual([true, true, true]);
    expect(saved.steps.map(step => step.args.text)).toEqual([
      "[REDACTED]",
      "[REDACTED]",
      "[REDACTED]",
    ]);
    expect(shown.text).toContain("[REDACTED]");
  });
  it("redacts sensitive values added through a meta-tool step", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const addHandler = recorderTools.find(t => t.tool.name === "recorder_add_step")!.handler;
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;
    const showHandler = recorderTools.find(t => t.tool.name === "recorder_show")!.handler;

    await startHandler({ name: "manual-redact-test", platform: "android" }, ctx);
    await addHandler({
      action_name: "input",
      args: { action: "text", text: "mypassword123" },
    }, ctx);
    await stopHandler({}, ctx);

    const result = await showHandler({ name: "manual-redact-test", platform: "android" }, ctx) as { text: string };
    expect(result.text).not.toContain("mypassword123");
    expect(result.text).toContain("[REDACTED]");
  });
  it("redacts nested browser form values added through a meta-tool step", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const addHandler = recorderTools.find(t => t.tool.name === "recorder_add_step")!.handler;
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;
    const showHandler = recorderTools.find(t => t.tool.name === "recorder_show")!.handler;

    await startHandler({ name: "browser-form-redact", platform: "android" }, ctx);
    await addHandler({
      action_name: "browser_fill_form",
      args: { fields: [{ selector: "#account", value: "hunter2" }] },
    }, ctx);
    await stopHandler({}, ctx);

    const result = await showHandler({ name: "browser-form-redact", platform: "android" }, ctx) as { text: string };
    expect(result.text).not.toContain("hunter2");
    expect(result.text).toContain("[REDACTED]");
  });

  it("classifies nested sensitive property names on new records", () => {
    const args = {
      selector: "#lookup",
      metadata: [{
        password: "lookup-password",
        details: { token: "lookup-token", selector: "#safe-selector" },
      }],
    };
    const inputBefore = JSON.stringify(args);

    const result = redactSensitiveArgs("ui_find", args);

    expect(result.sensitive).toBe(true);
    expect(JSON.stringify(result.args)).not.toContain("lookup-password");
    expect(JSON.stringify(result.args)).not.toContain("lookup-token");
    expect(JSON.stringify(result.args)).toContain("#safe-selector");
    expect(JSON.stringify(args)).toBe(inputBefore);
  });

  it("redacts nested sensitive values from status without mutating captured input", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;
    const statusHandler = recorderTools.find(t => t.tool.name === "recorder_status")!.handler;
    const nestedArgs = {
      text: "status-password",
      resourceId: "password_field",
      metadata: {
        selector: "#status-account",
        password: "status-property-password",
        token: "status-property-token",
        note: "status metadata",
        entries: [
          {
            selector: "#status-nested-field",
            text: "status-nested-text",
            value: "status-nested-value",
            marker: "keep-status-marker",
          },
        ],
      },
      fields: [{
        selector: "#status-field",
        value: "status-field-value",
        metadata: { text: "status-field-text", marker: "keep-field-marker" },
      }],
    };
    const inputBefore = JSON.stringify(nestedArgs);

    await startHandler({ name: "nested-status-redact", platform: "android" }, ctx);
    captureStep("input_text", nestedArgs, 0);

    const result = await statusHandler({}, ctx) as { text: string };
    expect(result.text).not.toContain("status-password");
    expect(result.text).not.toContain("status-nested-text");
    expect(result.text).not.toContain("status-nested-value");
    expect(result.text).not.toContain("status-field-value");
    expect(result.text).not.toContain("status-property-password");
    expect(result.text).not.toContain("status-property-token");
    expect(result.text).toContain("[REDACTED]");
    expect(result.text).toContain("#status-account");
    expect(result.text).toContain("keep-status-marker");
    expect(JSON.stringify(nestedArgs)).toBe(inputBefore);

    await stopHandler({ discard: true }, ctx);
  });

  it("redacts nested legacy values from show and both export formats without mutating stored input", async () => {
    const now = new Date().toISOString();
    const legacyArgs = {
      fields: [{
        selector: "#account",
        value: "legacy-field-value",
        metadata: {
          text: "legacy-field-text",
          value: "legacy-field-nested-value",
          marker: "keep-field-metadata",
        },
      }],
      metadata: {
        selector: "[data-account]",
        password: "legacy-password-key",
        marker: "keep-legacy-metadata",
        entries: [
          {
            selector: "#array-account",
            authToken: "legacy-auth-token",
            text: "legacy-array-text",
            value: "legacy-array-value",
            marker: "keep-array-metadata",
          },
          {
            selector: "#deep-account",
            details: {
              text: "legacy-deep-text",
              value: "legacy-deep-value",
              marker: "keep-deep-metadata",
            },
          },
        ],
      },
    };
    const nonSensitiveArgs = {
      selector: "#public",
      metadata: {
        text: "public nested text",
        value: "public nested value",
        marker: "keep-public-metadata",
      },
      entries: [{
        selector: "#public-array",
        text: "public array text",
        value: "public array value",
      }],
    };
    const legacyScenario: Scenario = {
      version: 1,
      name: "legacy-browser-fill-deep",
      platform: "android",
      description: "",
      tags: [],
      createdAt: now,
      updatedAt: now,
      checksum: "0".repeat(64),
      steps: [
        {
          index: 0,
          type: "data_input",
          action: "legacy_form_submit",
          args: legacyArgs,
          timestampMs: 0,
          delayBeforeMs: 0,
          sensitive: true,
          label: "legacy password label-secret",
        },
        {
          index: 1,
          type: "assert",
          action: "ui_assert_visible",
          args: nonSensitiveArgs,
          timestampMs: 1,
          delayBeforeMs: 0,
          label: "password=legacy-label-secret",
        },
      ],
      metadata: { recordedWithVersion: "test", totalRecordingTimeMs: 0 },
    };
    const storedStepsBefore = JSON.stringify(legacyScenario.steps);
    await new ScenarioStore().save(legacyScenario);

    const showHandler = recorderTools.find(t => t.tool.name === "recorder_show")!.handler;
    const exportHandler = recorderTools.find(t => t.tool.name === "recorder_export")!.handler;
    const outputs = await Promise.all([
      showHandler({ name: legacyScenario.name, platform: "android" }, ctx),
      exportHandler({ name: legacyScenario.name, platform: "android", format: "flow_steps" }, ctx),
      exportHandler({ name: legacyScenario.name, platform: "android", format: "markdown" }, ctx),
    ]) as Array<{ text: string }>;
    const playbackText = formatPlaybackResults(legacyScenario, [
      {
        step: 1,
        action: "legacy_form_submit",
        label: "legacy password label-secret",
        status: "OK",
        message: "OK",
        durationMs: 0,
      },
      {
        step: 2,
        action: "ui_assert_visible",
        label: "password=legacy-label-secret",
        status: "OK",
        message: "OK",
        durationMs: 0,
      },
    ], 0);
    const allOutputs = [...outputs, { text: playbackText }];

    const secrets = [
      "legacy-field-value",
      "legacy-field-text",
      "legacy-field-nested-value",
      "legacy-array-text",
      "legacy-array-value",
      "legacy-deep-text",
      "legacy-deep-value",
      "legacy-password-key",
      "legacy-auth-token",
      "legacy-label-secret",
    ];
    for (const output of allOutputs) {
      for (const secret of secrets) {
        expect(output.text).not.toContain(secret);
      }
      expect(output.text).toContain("[REDACTED]");
      expect(output.text).toContain("password=[REDACTED]");
    }
    for (const output of outputs) {
      expect(output.text).toContain("#account");
      expect(output.text).toContain("keep-legacy-metadata");
      expect(output.text).toContain("public nested text");
      expect(output.text).toContain("public array value");
    }
    expect(JSON.stringify(legacyScenario.steps)).toBe(storedStepsBefore);
  });
  it("sanitizes recorded labels before persistence and keeps harmless labels", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const addHandler = recorderTools.find(t => t.tool.name === "recorder_add_step")!.handler;
    const stopHandler = recorderTools.find(t => t.tool.name === "recorder_stop")!.handler;
    const statusHandler = recorderTools.find(t => t.tool.name === "recorder_status")!.handler;
    const showHandler = recorderTools.find(t => t.tool.name === "recorder_show")!.handler;
    const exportHandler = recorderTools.find(t => t.tool.name === "recorder_export")!.handler;

    await startHandler({ name: "label-redaction", platform: "android" }, ctx);
    await addHandler({
      action_name: "ui_assert_visible",
      args: { text: "Welcome" },
      label: "password=label-value",
    }, ctx);
    await addHandler({
      action_name: "input_text",
      args: { text: "label-value", resourceId: "password_field" },
      label: "enter password label-value",
    }, ctx);
    await addHandler({
      action_name: "input_tap",
      args: { text: "Continue" },
      label: "tap continue",
    }, ctx);
    await addHandler({
      action_name: "input_tap",
      args: { text: "Continue" },
      label: "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    }, ctx);

    const status = await statusHandler({}, ctx) as { text: string };
    expect(status.text).not.toContain("label-value");
    expect(status.text).toContain("[REDACTED]");
    expect(status.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(status.text).toContain("tap continue");


    await stopHandler({}, ctx);
    const saved = await new ScenarioStore().get("label-redaction", "android");
    expect(saved.steps.map(step => step.label)).toEqual([
      "[REDACTED]",
      "[REDACTED]",
      "tap continue",
      "[REDACTED]",
    ]);

    const outputs = await Promise.all([
      showHandler({ name: "label-redaction", platform: "android" }, ctx),
      exportHandler({ name: "label-redaction", platform: "android", format: "flow_steps" }, ctx),
      exportHandler({ name: "label-redaction", platform: "android", format: "markdown" }, ctx),
    ]) as Array<{ text: string }>;
    const playbackText = formatPlaybackResults(saved, [
      {
        step: 1,
        action: "ui_assert_visible",
        label: "password=label-value",
        status: "OK",
        message: "OK",
        durationMs: 0,
      },
      {
        step: 2,
        action: "input_text",
        label: "enter password label-value",
        status: "OK",
        message: "OK",
        durationMs: 0,
      },
      {
        step: 3,
        action: "input_tap",
        label: "tap continue",
        status: "OK",
        message: "OK",
        durationMs: 0,
      },
      {
        step: 4,
        action: "input_tap",
        label: "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
        status: "OK",
        message: "OK",
        durationMs: 0,
      },
    ], 0);

    for (const output of [...outputs, { text: playbackText }]) {
      expect(output.text).not.toContain("label-value");
      expect(output.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(output.text).toContain("[REDACTED]");
      expect(output.text).toContain("tap continue");
    }
  });

  it("rejects meta-tool shell steps before saving them", async () => {
    const startHandler = recorderTools.find(t => t.tool.name === "recorder_start")!.handler;
    const addHandler = recorderTools.find(t => t.tool.name === "recorder_add_step")!.handler;

    await startHandler({ name: "blocked-meta-test", platform: "android" }, ctx);
    await expect(addHandler({
      action_name: "system",
      args: { action: "shell", command: "id" },
    }, ctx)).rejects.toMatchObject({ code: "SCENARIO_ACTION_BLOCKED" });
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

// ── Playback timeout cancellation ──

describe("recorder playback", () => {
  const emptyScenario: Scenario = {
    version: 1,
    name: "empty",
    platform: "android",
    description: "",
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    checksum: "0".repeat(64),
    steps: [],
    metadata: { recordedWithVersion: "test", totalRecordingTimeMs: 0 },
  };

  it("never exposes nested tool values or errors in playback output", async () => {
    const action = "playback_nested_secret_audit";
    const resultSecret = "PLAYBACK_RESULT_SECRET_9f28";
    const errorSecret = "PLAYBACK_ERROR_SECRET_6bd1";
    registerTools([{
      tool: {
        name: action,
        description: "Playback secret regression action",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => ({ text: "registered" }),
    }]);
    const scenario: Scenario = {
      ...emptyScenario,
      name: "nested-result-redaction",
      steps: [{
        index: 0,
        type: "tool_call",
        action,
        args: {},
        timestampMs: 0,
        delayBeforeMs: 0,
      }],
    };

    const success = await executePlayback(
      scenario,
      {
        ...ctx,
        handleTool: async () => ({
          text: resultSecret,
          value: resultSecret,
        }) as never,
      },
      {},
      0,
    );
    const failed = await executePlayback(
      scenario,
      {
        ...ctx,
        handleTool: async () => {
          throw new Error(errorSecret);
        },
      },
      {},
      0,
    );
    const formatted = formatPlaybackResults(scenario, [
      {
        step: 1,
        action,
        status: "FAIL",
        message: errorSecret,
        durationMs: 0,
      },
    ], 0);

    for (const output of [
      JSON.stringify(success),
      formatPlaybackResults(scenario, success.results, success.totalMs),
      JSON.stringify(failed),
      formatPlaybackResults(scenario, failed.results, failed.totalMs),
      formatted,
    ]) {
      expect(output).not.toContain(resultSecret);
      expect(output).not.toContain(errorSecret);
    }
    expect(success.results[0]).toMatchObject({ status: "OK", message: "OK" });
    expect(failed.results[0]).toMatchObject({ status: "FAIL", message: "Action failed" });
    expect(formatted).toContain("Action failed");
  });

  it("rejects unsupported playback speeds while allowing zero delay", async () => {
    for (const speed of [-0.1, 10.1, Number.NaN]) {
      await expect(executePlayback(emptyScenario, ctx, { speed }, 0))
        .rejects.toThrow(ValidationError);
    }
    await expect(executePlayback(emptyScenario, ctx, { speed: 0 }, 0))
      .resolves.toMatchObject({ results: [] });
  });
  it("rejects meta-tool shell actions before playback", async () => {
    const scenario: Scenario = {
      ...emptyScenario,
      steps: [{
        index: 0,
        type: "tool_call",
        action: "system",
        args: { action: "shell", command: "id" },
        timestampMs: 0,
        delayBeforeMs: 0,
      }],
    };

    await expect(executePlayback(scenario, ctx, {}, 0))
      .rejects.toMatchObject({ code: "SCENARIO_ACTION_BLOCKED" });
  });
  it("rejects unsafe actions before invoking playback tools", async () => {
    const blocked: Array<{ action: string; args: Record<string, unknown> }> = [
      { action: "app_install", args: { path: "/tmp/app.apk" } },
      { action: "system_file_push", args: { localPath: "secret.bin" } },
      { action: "install_app", args: { path: "/tmp/app.apk" } },
      { action: "app_uninstall", args: { package: "com.example.app" } },
      { action: "uninstall_app", args: { package: "com.example.app" } },
      { action: "app", args: { action: "uninstall", package: "com.example.app" } },
      { action: "push_file", args: { localPath: "secret.bin" } },
      { action: "app", args: { action: "install", path: "/tmp/app.apk" } },
      { action: "system", args: { action: "file_push", localPath: "secret.bin" } },
      { action: "debug_eval", args: { expression: "1 + 1" } },
      { action: "debug_set_var", args: { name: "value", value: "changed" } },
      { action: "repl_spawn", args: { cmd: "env TOKEN=playback-secret run" } },
      { action: "repl_send", args: { id: "session-1", text: "export TOKEN=playback-secret" } },
    ];

    for (const { action, args } of blocked) {
      let invocations = 0;
      const playbackContext = {
        ...ctx,
        handleTool: async (
          name: string,
          toolArgs: Record<string, unknown>,
          depth?: number,
          signal?: AbortSignal,
        ) => {
          invocations += 1;
          return ctx.handleTool(name, toolArgs, depth, signal);
        },
      };
      const scenario: Scenario = {
        ...emptyScenario,
        steps: [{
          index: 0,
          type: "tool_call",
          action,
          args,
          timestampMs: 0,
          delayBeforeMs: 0,
        }],
      };

      await expect(executePlayback(scenario, playbackContext, {}, 0))
        .rejects.toMatchObject({ code: "SCENARIO_ACTION_BLOCKED" });
      expect(invocations).toBe(0);
    }
  });

  it("validates speed at the recorder tool boundary", async () => {
    const handler = recorderTools.find((tool) => tool.tool.name === "recorder_play")!.handler;
    await expect(handler({ name: "not-loaded", speed: 11 }, ctx))
      .rejects.toThrow(ValidationError);
  });


  it("does not start playback when the parent signal is already aborted", async () => {
    const parent = new AbortController();
    parent.abort();
    const action = "recorder_playback_parent_already_aborted";
    const startedActions: string[] = [];

    registerTools([{
      tool: { name: action, description: "Playback parent cancellation test action", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "registered" }),
    }]);

    const scenario: Scenario = {
      ...emptyScenario,
      name: "parent-already-aborted",
      steps: [
        {
          index: 0,
          type: "tool_call",
          action,
          args: {},
          timestampMs: 0,
          delayBeforeMs: 0,
        },
        {
          index: 1,
          type: "tool_call",
          action,
          args: {},
          timestampMs: 0,
          delayBeforeMs: 0,
        },
      ],
    };

    const playback = await executePlayback(
      scenario,
      {
        ...ctx,
        signal: parent.signal,
        handleTool: async (name: string) => {
          startedActions.push(name);
          return { text: "started" };
        },
      },
      {},
      0,
    );

    expect(startedActions).toEqual([]);
    expect(playback.results).toHaveLength(1);
    expect(playback.results[0]).toMatchObject({ status: "FAIL", message: "Playback cancelled" });
  });

  it("returns promptly on parent abort and does not retry or start later playback steps", async () => {
    let releaseFirst: () => void = () => {};
    let firstStartedResolve: () => void = () => {};
    let firstSignal: AbortSignal | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve;
    });
    const firstAction = new Promise<unknown>((resolve) => {
      releaseFirst = () => resolve({ text: "first done" });
    });
    const parent = new AbortController();
    const startedActions: string[] = [];
    const action = "recorder_playback_parent_abort_deferred";

    registerTools([{
      tool: { name: action, description: "Playback parent cancellation test action", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "registered" }),
    }]);

    const scenario: Scenario = {
      ...emptyScenario,
      name: "parent-abort-deferred",
      steps: [
        {
          index: 0,
          type: "tool_call",
          action,
          args: {},
          timestampMs: 0,
          delayBeforeMs: 0,
          onError: "retry",
        },
        {
          index: 1,
          type: "tool_call",
          action,
          args: {},
          timestampMs: 0,
          delayBeforeMs: 0,
        },
      ],
    };

    try {
      const playbackPromise = executePlayback(
        scenario,
        {
          ...ctx,
          signal: parent.signal,
          handleTool: async (name, _args, _depth, signal) => {
            startedActions.push(name);
            firstSignal = signal;
            firstStartedResolve();
            return firstAction;
          },
        },
        { stopOnFail: false },
        0,
      );

      await firstStarted;
      parent.abort();

      const playback = await playbackPromise;
      expect(firstSignal?.aborted).toBe(true);
      expect(startedActions).toEqual([action]);
      expect(playback.results).toHaveLength(1);
      expect(playback.results[0]).toMatchObject({ status: "FAIL", message: "Playback cancelled" });
      expect(formatPlaybackResults(scenario, playback.results, playback.totalMs))
        .toContain("Playback cancelled");
    } finally {
      releaseFirst();
    }
  });

  it("returns promptly and aborts a timed-out action without starting later steps", async () => {
    vi.useFakeTimers();
    let releaseFirst: () => void = () => {};
    let firstStartedResolve: () => void = () => {};
    let firstSettled = false;
    let firstSignal: AbortSignal | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve;
    });
    const firstAction = new Promise<unknown>((resolve) => {
      releaseFirst = () => {
        firstSettled = true;
        resolve({ text: "first done" });
      };
    });
    const startedActions: string[] = [];
    const action = "recorder_playback_deferred";

    registerTools([{
      tool: { name: action, description: "Playback test action", inputSchema: { type: "object", properties: {} } },
      handler: async () => ({ text: "registered" }),
    }]);

    const scenario: Scenario = {
      version: 1,
      name: "timeout-settling",
      platform: "android",
      description: "",
      tags: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      checksum: "0".repeat(64),
      steps: [
        {
          index: 0,
          type: "tool_call",
          action,
          args: {},
          timestampMs: 0,
          delayBeforeMs: 0,
          onError: "skip",
        },
        {
          index: 1,
          type: "tool_call",
          action,
          args: {},
          timestampMs: 0,
          delayBeforeMs: 0,
        },
      ],
      metadata: {
        recordedWithVersion: "test",
        totalRecordingTimeMs: 0,
      },
    };

    let playbackReturned = false;
    try {
      const playbackPromise = executePlayback(
        scenario,
        {
          ...ctx,
          handleTool: async (name, _args, _depth, signal) => {
            startedActions.push(name);
            if (startedActions.length === 1) {
              firstSignal = signal;
              firstStartedResolve();
              return firstAction;
            }
            return { text: "second started" };
          },
        },
        { stepTimeout: 10, stopOnFail: false },
        0,
      ).then((result) => {
        playbackReturned = true;
        return result;
      });

      await firstStarted;
      await vi.advanceTimersByTimeAsync(10);

      expect(firstSettled).toBe(false);
      expect(playbackReturned).toBe(true);
      expect(firstSignal?.aborted).toBe(true);
      expect(startedActions).toEqual([action]);

      const playback = await playbackPromise;
      expect(playback.results).toHaveLength(1);
      expect(playback.results[0].status).toBe("FAIL");
      expect(playback.results[0].message).toBe("Step timeout");
    } finally {
      releaseFirst();
      vi.useRealTimers();
    }
  });
});
