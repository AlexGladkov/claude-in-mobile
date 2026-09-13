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

  it("delegates adapter and plugin disposal to the client", async () => {
    const stop = vi.fn(async () => {});
    const adapter = new DesktopAdapter({ stop } as unknown as DesktopClient);
    const plugin = new DesktopPlugin(adapter);

    await plugin.dispose();

    expect(stop).toHaveBeenCalledOnce();
  });
});
