/**
 * Pure normalisation of the flat {@link RawLaunchOptions} into the strict
 * discriminated-union {@link LaunchOptions}. Lives next to the DesktopClient
 * but is intentionally stateless so it can be unit-tested in isolation and
 * imported without dragging in the RPC state machine.
 */

import * as path from "node:path";

import { MobileError } from "mcp-devices/errors";
import {
  validateBundleId,
  validateJvmArg,
  validatePath,
} from "mcp-devices/utils/sanitize";
import type { LaunchOptions, RawLaunchOptions } from "./types.js";

const GRADLE_TASK_RE = /^:?[A-Za-z][A-Za-z0-9:_-]{0,255}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function validateEnvironment(env: Record<string, string> | undefined): void {
  if (!env) return;
  const entries = Object.entries(env);
  if (entries.length > 128) {
    throw new MobileError("Too many environment variables.", "INVALID_LAUNCH_OPTIONS");
  }
  for (const [name, value] of entries) {
    if (!ENV_NAME_RE.test(name) || value.length > 8192 || /[\u0000\r\n]/.test(value)) {
      throw new MobileError("Invalid environment variable.", "INVALID_LAUNCH_OPTIONS");
    }
  }
}

/**
 * Normalise a flat RawLaunchOptions into the strict discriminated-union LaunchOptions.
 * Throws on conflicting fields (e.g. mode:"gradle" + pid).
 */
export function normalizeLaunchOptions(raw: RawLaunchOptions): LaunchOptions {
  if (raw.projectPath !== undefined) {
    validatePath(raw.projectPath, "projectPath");
    if (!path.isAbsolute(raw.projectPath)) {
      throw new MobileError("projectPath must be absolute.", "INVALID_LAUNCH_OPTIONS");
    }
  }
  if (raw.appPath !== undefined) validatePath(raw.appPath, "appPath");
  if (raw.bundleId !== undefined) validateBundleId(raw.bundleId);
  if (raw.task !== undefined && !GRADLE_TASK_RE.test(raw.task)) {
    throw new MobileError("Invalid Gradle task.", "INVALID_LAUNCH_OPTIONS");
  }
  if (raw.jvmArgs !== undefined) {
    if (raw.jvmArgs.length > 64) {
      throw new MobileError("Too many JVM arguments.", "INVALID_LAUNCH_OPTIONS");
    }
    for (const argument of raw.jvmArgs) validateJvmArg(argument);
  }
  validateEnvironment(raw.env);
  if (raw.pid !== undefined && (!Number.isSafeInteger(raw.pid) || raw.pid <= 0)) {
    throw new MobileError("Invalid pid.", "INVALID_LAUNCH_OPTIONS");
  }
  // Detect conflicting params: mode-specific fields must not bleed across modes
  if (raw.mode === "gradle" && (raw.bundleId !== undefined || raw.appPath !== undefined || raw.pid !== undefined)) {
    throw new MobileError(
      `Conflicting launch parameters: mode "gradle" does not accept bundleId, appPath, or pid`,
      "INVALID_LAUNCH_OPTIONS"
    );
  }
  if (raw.mode === "bundle" && (raw.pid !== undefined || raw.projectPath !== undefined)) {
    throw new MobileError(
      `Conflicting launch parameters: mode "bundle" does not accept pid or projectPath`,
      "INVALID_LAUNCH_OPTIONS"
    );
  }
  if (raw.mode === "attach" && (raw.bundleId !== undefined || raw.appPath !== undefined || raw.projectPath !== undefined)) {
    throw new MobileError(
      `Conflicting launch parameters: mode "attach" does not accept bundleId, appPath, or projectPath`,
      "INVALID_LAUNCH_OPTIONS"
    );
  }

  if (raw.mode) {
    // Explicit mode — build typed object (do not cast)
    switch (raw.mode) {
      case "gradle":
        if (!raw.projectPath) throw new MobileError(`mode "gradle" requires projectPath`, "INVALID_LAUNCH_OPTIONS");
        return { mode: "gradle", projectPath: raw.projectPath, task: raw.task, jvmArgs: raw.jvmArgs, env: raw.env };
      case "bundle":
        if (!raw.bundleId && !raw.appPath) throw new MobileError(`mode "bundle" requires bundleId or appPath`, "INVALID_LAUNCH_OPTIONS");
        // After the check, at least one is defined — split to satisfy the XOR union type
        if (raw.bundleId) {
          return { mode: "bundle", bundleId: raw.bundleId, appPath: raw.appPath, env: raw.env };
        }
        if (!raw.appPath) throw new MobileError("Invalid appPath.", "INVALID_LAUNCH_OPTIONS");
        return { mode: "bundle", appPath: raw.appPath, env: raw.env };
      case "attach":
        if (raw.pid === undefined) throw new MobileError(`mode "attach" requires pid`, "INVALID_LAUNCH_OPTIONS");
        return { mode: "attach", pid: raw.pid };
      case "companion-only":
        return { mode: "companion-only" };
      default:
        throw new MobileError("Unknown launch mode.", "INVALID_LAUNCH_OPTIONS");
    }
  }

  // Legacy: infer mode from fields present
  if (raw.projectPath) {
    return { mode: "gradle", projectPath: raw.projectPath, task: raw.task, jvmArgs: raw.jvmArgs, env: raw.env };
  }
  return { mode: "companion-only" };
}
