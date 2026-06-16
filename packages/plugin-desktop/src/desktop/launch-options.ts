/**
 * Pure normalisation of the flat {@link RawLaunchOptions} into the strict
 * discriminated-union {@link LaunchOptions}. Lives next to the DesktopClient
 * but is intentionally stateless so it can be unit-tested in isolation and
 * imported without dragging in the RPC state machine.
 */

import { MobileError } from "claude-in-mobile/errors";
import type { LaunchOptions, RawLaunchOptions } from "./types.js";

/**
 * Normalise a flat RawLaunchOptions into the strict discriminated-union LaunchOptions.
 * Throws on conflicting fields (e.g. mode:"gradle" + pid).
 */
export function normalizeLaunchOptions(raw: RawLaunchOptions): LaunchOptions {
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
        return { mode: "bundle", appPath: raw.appPath!, env: raw.env };
      case "attach":
        if (raw.pid === undefined) throw new MobileError(`mode "attach" requires pid`, "INVALID_LAUNCH_OPTIONS");
        return { mode: "attach", pid: raw.pid };
      case "companion-only":
        return { mode: "companion-only" };
      default:
        throw new MobileError(
          `Unknown launch mode: "${raw.mode}". Valid values: gradle, bundle, attach, companion-only`,
          "INVALID_LAUNCH_OPTIONS"
        );
    }
  }

  // Legacy: infer mode from fields present
  if (raw.projectPath) {
    return { mode: "gradle", projectPath: raw.projectPath, task: raw.task, jvmArgs: raw.jvmArgs, env: raw.env };
  }
  return { mode: "companion-only" };
}
