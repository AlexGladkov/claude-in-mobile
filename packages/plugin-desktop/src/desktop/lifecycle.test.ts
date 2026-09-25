import type * as FsModule from "fs";
import { createRequire } from "node:module";
import * as fs from "fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopClient } from "./client.js";
import { GradleLauncher } from "./gradle.js";
import { BundleAppLauncher } from "./launchers.js";
import { DesktopAdapter } from "../desktop-adapter.js";
import { DesktopPlugin } from "../index.js";
import type { RawLaunchOptions } from "./types.js";
import { findCompanionAppPath } from "./permission-allowlist.js";
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

const realExistsSync = vi.mocked(fs.existsSync).getMockImplementation()!;

interface ClientHarness {
  process: ChildProcess | null;
  state: { status: string; crashCount: number; targetPid: number | null; pid?: number };
  restartTimer?: NodeJS.Timeout;
  lastLaunchOptions: unknown;
  activeStrategy: { stop(): void | Promise<void> } | null;
  targetPid: number | undefined;
  handleExit(
    child: ChildProcess,
    epoch: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void;
}

interface BundleLauncherHarness {
  directProcess: ChildProcess | null;
  getExecutablePath(bundleId: string, resolvedPath?: string): string;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(fs.existsSync).mockImplementation(realExistsSync);
});
describe("desktop companion resolution", () => {
  it("finds the companion packaged in the mcp-devices dependency", () => {
    const entry = createRequire(import.meta.url).resolve("mcp-devices");
    const packageRoot = path.resolve(path.dirname(entry), "..");
    const expected = path.join(
      packageRoot,
      "desktop-companion",
      "build",
      "install",
      "desktop-companion",
      "bin",
      "desktop-companion",
    );
    vi.mocked(fs.existsSync).mockImplementation((candidate) => String(candidate) === expected);

    expect(findCompanionAppPath()).toBe(expected);
  });
});

describe("Desktop process lifecycle", () => {
  it("does not treat ChildProcess.killed as process exit", () => {
    const client = new DesktopClient();
    const harness = client as unknown as ClientHarness;
    harness.process = {
      killed: true,
      exitCode: null,
      signalCode: null,
    } as unknown as ChildProcess;
    harness.state = { status: "running", crashCount: 0, targetPid: null };

    expect(client.isRunning()).toBe(true);
  });

  it("returns to stopped state when launch option validation fails", async () => {
    const client = new DesktopClient();
    const invalid = { mode: "teleport" } as unknown as RawLaunchOptions;

    const firstError = await client.launch(invalid).catch((error: unknown) => error);
    expect(firstError).toBeInstanceOf(Error);
    expect(client.getState().status).toBe("stopped");
    const retryError = await client.launch(invalid).catch((error: unknown) => error);
    expect(retryError).toBeInstanceOf(Error);
  });

  it("stops the active strategy when the companion exits cleanly", async () => {
    const client = new DesktopClient();
    const harness = client as unknown as ClientHarness;
    const child = new EventEmitter() as unknown as ChildProcess;
    const stop = vi.fn();
    harness.process = child;
    harness.state = { status: "running", crashCount: 0, targetPid: 123, pid: 456 };
    harness.targetPid = 123;
    harness.activeStrategy = { stop };

    harness.handleExit(child, 0, 0, null);

    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledOnce();
      expect(harness.process).toBeNull();
      expect(client.getState()).toMatchObject({ status: "stopped", targetPid: null });
      expect(client.getState().pid).toBeUndefined();
    });
  });

  it("surfaces strategy cleanup failure after resetting lifecycle state", async () => {
    const client = new DesktopClient();
    const harness = client as unknown as ClientHarness;
    harness.state = { status: "running", crashCount: 0, targetPid: 123 };
    harness.activeStrategy = {
      stop: vi.fn(async () => {
        throw new Error("bundle still running");
      }),
    };

    await expect(client.stop()).rejects.toThrow(
      "Desktop teardown failed: bundle still running",
    );
    expect(client.getState()).toMatchObject({ status: "stopped", targetPid: null });
  });

  it("awaits SIGKILL fallback when SIGTERM does not stop the process", async () => {
    vi.useFakeTimers();
    let child: ChildProcess;
    const kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") {
        queueMicrotask(() => {
          Object.assign(child, { exitCode: 0 });
          child.emit("exit", 0, null);
        });
      }
      return true;
    });
    child = Object.assign(new EventEmitter(), {
      killed: true,
      exitCode: null,
      pid: 42_424,
      signalCode: null,
      kill,
    }) as unknown as ChildProcess;

    const stopping = new GradleLauncher().stop(child);
    expect(kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
  });

  it("awaits termination of a directly bundle-launched process", async () => {
    let releaseStop: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => { releaseStop = resolve; });
    const gradle = { stop: vi.fn(() => stopped) } as unknown as GradleLauncher;
    const launcher = new BundleAppLauncher(
      { mode: "bundle", bundleId: "com.example.app", env: { TEST: "1" } },
      gradle,
      () => {},
    );
    const child = new EventEmitter() as unknown as ChildProcess;
    const launcherHarness = launcher as unknown as BundleLauncherHarness;
    launcherHarness.directProcess = child;
    const stopping = launcher.stop();
    await Promise.resolve();

    expect(gradle.stop).toHaveBeenCalledWith(child);
    let settled = false;
    void stopping.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseStop?.();
    await stopping;
  });

  it("handles asynchronous bundle spawn failure without leaking an error event", async () => {
    const launcher = new BundleAppLauncher(
      { mode: "bundle", bundleId: "com.example.missing" },
      new GradleLauncher(),
      () => {},
    );
    const launcherHarness = launcher as unknown as BundleLauncherHarness;
    launcherHarness.getExecutablePath = () =>
      join(tmpdir(), `missing-mcp-devices-app-${process.pid}`);

    const launchError = await launcher.launch().catch((error: unknown) => error);
    expect(launchError).toBeInstanceOf(Error);
    await expect(launcher.stop()).resolves.toBeUndefined();
  });

  it("maps desktop UI records for normalized consumers and redacts value-bearing text fields", async () => {
    const otp = "731904";
    const hierarchy = {
      windows: [],
      scaleFactor: 1,
      elements: [
        {
          index: 0,
          id: "password-field",
          text: "hunter2",
          contentDescription: "Password",
          className: "SecureTextField",
          role: "AXSecureTextField",
          bounds: { x: 10, y: 20, width: 200, height: 40 },
          clickable: false,
          enabled: true,
          focused: true,
          focusable: true,
          password: true,
          children: [],
          centerX: 110,
          centerY: 40,
        },
        {
          index: 1,
          id: "otp-field",
          text: otp,
          contentDescription: otp,
          className: "TextField",
          role: "AXTextField",
          bounds: { x: 10, y: 80, width: 200, height: 40 },
          clickable: false,
          enabled: true,
          focused: false,
          focusable: true,
          password: false,
          children: [],
          centerX: 110,
          centerY: 100,
        },
        {
          index: 2,
          id: "continue",
          text: "Continue",
          contentDescription: "Continue",
          className: "Button",
          role: "button",
          bounds: { x: 30, y: 150, width: 120, height: 44 },
          clickable: true,
          enabled: true,
          focused: false,
          focusable: true,
          children: [],
          centerX: 90,
          centerY: 172,
        },
      ],
    };
    const client = {
      isRunning: () => true,
      getUiHierarchy: vi.fn(async () => hierarchy),
    } as unknown as DesktopClient;
    const adapter = new DesktopAdapter(client);

    const elements = await adapter.getUiElements();
    expect(elements[0]).toMatchObject({
      id: "[REDACTED]",
      role: "AXSecureTextField",
      className: "SecureTextField",
      text: "[REDACTED]",
      label: "[REDACTED]",
      contentDesc: "[REDACTED]",
      enabled: true,
      focused: true,
      clickable: false,
      focusable: true,
      password: true,
      bounds: { x: 10, y: 20, width: 200, height: 40 },
    });
    expect(elements[1]).toMatchObject({
      id: "[REDACTED]",
      role: "AXTextField",
      className: "TextField",
      text: "[REDACTED]",
      label: "[REDACTED]",
      contentDesc: "[REDACTED]",
      password: true,
      bounds: { x: 10, y: 80, width: 200, height: 40 },
    });
    expect(elements[2]).toMatchObject({
      id: "continue",
      text: "Continue",
      label: "Continue",
      contentDesc: "Continue",
    });
    expect(JSON.stringify(elements)).not.toContain("hunter2");
    expect(JSON.stringify(elements)).not.toContain(otp);

    const legacy = await adapter.getUiHierarchy();
    expect(legacy).not.toContain("hunter2");
    expect(legacy).not.toContain(otp);
    expect(legacy).toContain("[REDACTED]");
    expect(legacy).toContain("Continue");
    expect(legacy).toContain("(110, 100)");
    expect(legacy).toContain("(90, 172)");
  });

  it("redacts empty text-entry IDs and sanitizes device-provided UI strings", async () => {
    const dynamicId = "textfield-user@example.com";
    const hostileTitle = "Settings\u001b]0;spoof\u0007\u202E";
    const hostileText = "Save\u001b[31m\u0000\u202E";
    const hierarchy = {
      windows: [{
        id: "window-1",
        title: hostileTitle,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        focused: true,
        minimized: false,
        fullscreen: false,
      }],
      scaleFactor: 1,
      elements: [
        {
          index: 0,
          id: dynamicId,
          text: "",
          contentDescription: "Email address",
          className: "TextField",
          role: "AXTextField",
          bounds: { x: 10, y: 20, width: 200, height: 40 },
          clickable: false,
          enabled: true,
          focused: true,
          focusable: true,
          children: [],
          centerX: 110,
          centerY: 40,
        },
        {
          index: 1,
          id: "continue",
          text: "Continue",
          contentDescription: "Continue",
          className: "Button",
          role: "button",
          bounds: { x: 30, y: 150, width: 120, height: 44 },
          clickable: true,
          enabled: true,
          focused: false,
          focusable: true,
          children: [],
          centerX: 90,
          centerY: 172,
        },
        {
          index: 2,
          id: "save",
          text: hostileText,
          contentDescription: hostileText,
          className: "Button\u000b",
          role: "button\u202E",
          bounds: { x: 30, y: 210, width: 120, height: 44 },
          clickable: true,
          enabled: true,
          focused: false,
          focusable: true,
          children: [],
          centerX: 90,
          centerY: 232,
        },
      ],
    };
    const client = {
      isRunning: () => true,
      getUiHierarchy: vi.fn(async () => hierarchy),
    } as unknown as DesktopClient;
    const adapter = new DesktopAdapter(client);

    const elements = await adapter.getUiElements();
    expect(elements[0]).toMatchObject({
      id: "[REDACTED]",
      role: "AXTextField",
      className: "TextField",
      text: "",
      label: "Email address",
      contentDesc: "Email address",
    });
    expect(elements[1]).toMatchObject({
      id: "continue",
      role: "button",
      className: "Button",
      text: "Continue",
      label: "Continue",
      contentDesc: "Continue",
    });
    expect(elements[2]).toMatchObject({
      id: "save",
      role: "button ",
      className: "Button ",
      text: "Save  ",
      label: "Save  ",
      contentDesc: "Save  ",
    });

    const serializedElements = JSON.stringify(elements);
    expect(serializedElements).not.toContain(dynamicId);
    expect(serializedElements).not.toContain("\\u001b");
    expect(serializedElements).not.toContain("\\u0000");
    expect(serializedElements).not.toContain("\\u000b");
    expect(serializedElements).not.toContain("\\u202e");

    const legacy = await adapter.getUiHierarchy();
    expect(legacy).toContain("Settings ");
    expect(legacy).toContain("Continue");
    expect(legacy).toContain("Save  ");
    expect(legacy).not.toContain("spoof");
    expect(legacy).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
  });

  it("delegates adapter and plugin disposal to the client", async () => {
    const stop = vi.fn(async () => {});
    const adapter = new DesktopAdapter({ stop } as unknown as DesktopClient);
    const plugin = new DesktopPlugin(adapter);

    await plugin.dispose();

    expect(stop).toHaveBeenCalledOnce();
  });
});
