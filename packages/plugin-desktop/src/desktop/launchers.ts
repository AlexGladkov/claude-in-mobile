/**
 * App-launch strategies for the desktop companion.
 *
 * Each strategy encapsulates how a single LaunchOptions variant is realised:
 * `gradle` runs a Gradle task, `bundle` uses `open`/spawn, `attach` validates an
 * existing pid, and `companion-only` is a no-op (the companion runs solo).
 *
 * The strategies are intentionally small and pid-returning so the DesktopClient
 * can stay agnostic about platform details.
 */

import { ChildProcess, execFileSync, spawn } from "child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GradleLauncher } from "./gradle.js";
import { MobileError } from "mcp-devices/errors";
import { validateBundleId } from "mcp-devices/utils/sanitize";
import type { LaunchOptions, LogType } from "./types.js";
import {
  getBundleIdFromAppPath,
  validateAndResolveAppPath,
  validateAttachPid,
} from "./permission-allowlist.js";

/** Strategy interface — returns the targetPid of the launched/attached app, or null. */
export interface AppLaunchStrategy {
  launch(): Promise<number | null>;
  stop(): Promise<void>;
}

export class GradleAppLauncher implements AppLaunchStrategy {
  private userAppProcess: ChildProcess | null = null;

  constructor(
    private readonly opts: Extract<LaunchOptions, { mode: "gradle" }>,
    private readonly gradleLauncher: GradleLauncher,
    private readonly addLog: (type: LogType, msg: string) => void
  ) {}

  async launch(): Promise<number | null> {
    this.addLog("stdout", "Launching user app through Gradle.");
    this.userAppProcess = this.gradleLauncher.launch({ ...this.opts });
    this.userAppProcess.stdout?.on("data", (data: Buffer) => this.addLog("stdout", `[UserApp] ${data.toString()}`));
    this.userAppProcess.stderr?.on("data", (data: Buffer) => this.addLog("stderr", `[UserApp] ${data.toString()}`));
    return null;
  }

  async stop(): Promise<void> {
    const child = this.userAppProcess;
    this.userAppProcess = null;
    if (child) await this.gradleLauncher.stop(child);
  }
}

export class BundleAppLauncher implements AppLaunchStrategy {
  private directProcess: ChildProcess | null = null;

  constructor(
    private readonly opts: Extract<LaunchOptions, { mode: "bundle" }>,
    private readonly gradleLauncher: GradleLauncher,
    private readonly addLog: (type: LogType, msg: string) => void
  ) {}
  async launch(): Promise<number | null> {
    // Both bundleId and appPath are pre-validated by normalizeLaunchOptions — at least one is set.
    const { bundleId, appPath, env } = this.opts;
    let resolvedBundleId: string;
    let resolvedPath: string | undefined;

    if (bundleId) {
      validateBundleId(bundleId);
      resolvedBundleId = bundleId;
    } else {
      resolvedPath = validateAndResolveAppPath(appPath!);
      resolvedBundleId = getBundleIdFromAppPath(resolvedPath);
      validateBundleId(resolvedBundleId);
    }

    const binaryPath = this.getExecutablePath(resolvedBundleId, resolvedPath);
    this.addLog("stdout", "Launching owned application process.");
    const child = spawn(binaryPath, [], {
      env: { ...process.env, ...env },
      detached: true,
      stdio: "ignore",
    });
    this.directProcess = child;
    const spawned = this.waitForSpawn(child);
    child.on("error", () => {
      this.addLog("stderr", "Owned app process failed.");
    });
    await spawned;
    child.unref();
    const targetPid = child.pid;
    if (!targetPid) {
      throw new MobileError("Failed to obtain application PID.", "BUNDLE_LAUNCH_FAILED");
    }

    this.addLog("stdout", `App started with PID ${targetPid}`);
    return targetPid;
  }

  async stop(): Promise<void> {
    const directProcess = this.directProcess;
    if (!directProcess) return;
    await this.gradleLauncher.stop(directProcess);
    if (this.directProcess === directProcess) this.directProcess = null;
  }

  private getExecutablePath(bundleId: string, resolvedPath?: string): string {
    const appPath = validateAndResolveAppPath(
      resolvedPath ?? this.getAppPathFromBundleId(bundleId),
    );
    try {
      const binaryName = execFileSync(
        "/usr/bin/defaults",
        ["read", `${appPath}/Contents/Info`, "CFBundleExecutable"],
        { encoding: "utf-8", timeout: 3000, maxBuffer: 64 * 1024 },
      ).trim();
      if (
        binaryName.length === 0
        || binaryName.length > 255
        || /[\u0000-\u001f\u007f]/.test(binaryName)
        || path.basename(binaryName) !== binaryName
      ) {
        throw new Error("invalid executable name");
      }
      const executable = fs.realpathSync(path.join(appPath, "Contents", "MacOS", binaryName));
      const relative = path.relative(appPath, executable);
      if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.statSync(executable).isFile()) {
        throw new Error("executable outside bundle");
      }
      return executable;
    } catch {
      throw new MobileError(
        "Application bundle declares an invalid executable.",
        "BUNDLE_EXECUTABLE_INVALID",
      );
    }
  }

  private waitForSpawn(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new MobileError("Failed to launch application.", "BUNDLE_LAUNCH_FAILED"));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }
  private getAppPathFromBundleId(bundleId: string): string {
    try {
      const result = execFileSync(
        "/usr/bin/osascript",
        ["-e", `POSIX path of (path to application id "${bundleId}")`],
        { encoding: "utf-8", timeout: 5000, maxBuffer: 64 * 1024 },
      ).trim();
      return result.replace(/\/$/, "");
    } catch {
      throw new MobileError("Cannot find application path.", "BUNDLE_PATH_NOT_FOUND");
    }
  }
}

export class AttachLauncher implements AppLaunchStrategy {
  constructor(
    private readonly opts: Extract<LaunchOptions, { mode: "attach" }>,
    private readonly addLog: (type: LogType, msg: string) => void
  ) {}

  async launch(): Promise<number | null> {
    validateAttachPid(this.opts.pid);
    this.addLog("stdout", `Attaching to existing process with PID ${this.opts.pid}`);
    return this.opts.pid;
  }

  async stop(): Promise<void> {}
}

export class NoOpLauncher implements AppLaunchStrategy {
  async launch(): Promise<number | null> { return null; }
  async stop(): Promise<void> {}
}
