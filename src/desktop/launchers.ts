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
import type { GradleLauncher } from "./gradle.js";
import { MobileError } from "../errors.js";
import { validateBundleId } from "../utils/sanitize.js";
import type { LaunchOptions, LogType } from "./types.js";
import {
  BUNDLE_LAUNCH_POLL_INTERVAL_MS,
  getBundleIdFromAppPath,
  resolvePidByBundleId,
  validateAndResolveAppPath,
  validateAttachPid,
} from "./permission-allowlist.js";

/** Strategy interface — returns the targetPid of the launched/attached app, or null. */
export interface AppLaunchStrategy {
  launch(): Promise<number | null>;
  stop(): void;
}

export class GradleAppLauncher implements AppLaunchStrategy {
  private userAppProcess: ChildProcess | null = null;

  constructor(
    private readonly opts: Extract<LaunchOptions, { mode: "gradle" }>,
    private readonly gradleLauncher: GradleLauncher,
    private readonly addLog: (type: LogType, msg: string) => void
  ) {}

  async launch(): Promise<number | null> {
    this.addLog("stdout", `Launching user app from: ${this.opts.projectPath}`);
    // Spread to satisfy RawLaunchOptions (no as any — structural types are compatible)
    this.userAppProcess = this.gradleLauncher.launch({ ...this.opts });
    this.userAppProcess.stdout?.on("data", (data: Buffer) => this.addLog("stdout", `[UserApp] ${data.toString()}`));
    this.userAppProcess.stderr?.on("data", (data: Buffer) => this.addLog("stderr", `[UserApp] ${data.toString()}`));
    return null;
  }

  stop(): void {
    if (this.userAppProcess) {
      this.gradleLauncher.stop(this.userAppProcess);
      this.userAppProcess = null;
    }
  }
}

export class BundleAppLauncher implements AppLaunchStrategy {
  stop(): void {}

  constructor(
    private readonly opts: Extract<LaunchOptions, { mode: "bundle" }>,
    private readonly addLog: (type: LogType, msg: string) => void
  ) {}

  async launch(): Promise<number | null> {
    // Both bundleId and appPath are pre-validated by normalizeLaunchOptions — at least one is set.
    const { bundleId, appPath, env } = this.opts;
    const hasEnv = env && Object.keys(env).length > 0;
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

    this.addLog("stdout", `Launching app: ${bundleId ?? resolvedPath}${hasEnv ? ` (with env: ${Object.keys(env!).join(", ")})` : ""}`);

    if (hasEnv) {
      // `open` cannot pass env vars to the launched app — spawn the binary directly.
      // resolvedPath is always set when env is used with appPath; derive it from bundleId otherwise.
      const appPath_ = resolvedPath ?? this.getAppPathFromBundleId(resolvedBundleId);
      const binaryName = execFileSync(
        "defaults", ["read", `${appPath_}/Contents/Info`, "CFBundleExecutable"],
        { encoding: "utf-8", timeout: 3000 }
      ).trim();
      const binaryPath = `${appPath_}/Contents/MacOS/${binaryName}`;
      spawn(binaryPath, [], {
        env: { ...process.env, ...env },
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      // No env vars needed — use `open` (proper app launch via LaunchServices)
      try {
        if (resolvedPath) {
          // Pass the realpath-resolved path to `open` to prevent TOCTOU
          execFileSync("open", [resolvedPath], { timeout: 5000 });
        } else {
          execFileSync("open", ["-b", resolvedBundleId], { timeout: 5000 });
        }
      } catch (e: any) {
        throw new MobileError(`Failed to launch app "${bundleId ?? resolvedPath}": ${e.message}`, "BUNDLE_LAUNCH_FAILED");
      }
    }

    this.addLog("stdout", `Waiting for app to start (polling every ${BUNDLE_LAUNCH_POLL_INTERVAL_MS}ms)...`);
    const targetPid = await resolvePidByBundleId(resolvedBundleId);
    this.addLog("stdout", `App started with PID ${targetPid}`);
    return targetPid;
  }

  private getAppPathFromBundleId(bundleId: string): string {
    try {
      const result = execFileSync(
        "osascript", ["-e", `POSIX path of (path to application id "${bundleId}")`],
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      // Strip trailing slash that osascript adds
      return result.replace(/\/$/, "");
    } catch (e: any) {
      throw new MobileError(`Cannot find app path for bundle ID "${bundleId}": ${e.message}`, "BUNDLE_PATH_NOT_FOUND");
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

  stop(): void {}
}

export class NoOpLauncher implements AppLaunchStrategy {
  async launch(): Promise<number | null> { return null; }
  stop(): void {}
}
