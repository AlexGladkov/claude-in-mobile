/**
 * exec.ts — Standalone exec utilities for the debug plugin.
 *
 * Contains:
 *  - Input validation (validatePackageName / validateDeviceId / validateBundleId)
 *    — copied from main src/utils/sanitize.ts so this package has zero dependency
 *    on the mcp-devices main bundle (security boundary: independent trust validation).
 *  - AdbRunner factory (argv-based, no shell:true — CWE-78 safe).
 *  - simctl exec helper.
 *
 * SECURITY: All exec calls use execFile with argv arrays — no shell:true,
 * no string concatenation. Validation happens BEFORE exec is called.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

// ---------- Validation errors (standalone, no mcp-devices dep) ----------

export class DebugValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "DebugValidationError";
  }
}

// C3: package name — dotted identifier (com.example.app)
const PACKAGE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;

export function validatePackageName(name: string): void {
  if (!PACKAGE_NAME_RE.test(name)) {
    throw new DebugValidationError(
      `Invalid package name: "${name}". Expected format: com.example.app`,
      "INVALID_PACKAGE_NAME",
    );
  }
}

// C4: device serial — alphanumeric, dots, colons, hyphens, underscores, @
export function validateDeviceId(id: string): void {
  if (!/^[a-zA-Z0-9._:@\-]+$/.test(id)) {
    throw new DebugValidationError(`Invalid device ID format: ${id}`, "INVALID_DEVICE_ID");
  }
}

// C8: bundle id — reverse-DNS format, first char of each segment must be a letter
const BUNDLE_ID_RE = /^[a-zA-Z][a-zA-Z0-9\-]*(\.[a-zA-Z][a-zA-Z0-9\-]*){1,}$/;

export function validateBundleId(id: string): void {
  if (!id || id.length > 255) {
    throw new DebugValidationError(
      `Invalid bundleId length: must be 1-255 characters`,
      "INVALID_BUNDLE_ID",
    );
  }
  if (!BUNDLE_ID_RE.test(id)) {
    throw new DebugValidationError(
      `Invalid bundleId: "${id}". Expected reverse-DNS format (e.g. com.apple.TextEdit)`,
      "INVALID_BUNDLE_ID",
    );
  }
}

// ---------- AdbRunner ----------

/** Runs adb with the given argv array; returns stdout. Shell-safe (no string concat). */
export type AdbRunner = (args: string[]) => Promise<string>;

/**
 * Build an AdbRunner bound to an optional device serial.
 * Uses ADB_PATH env if set, otherwise "adb" (from PATH).
 * SECURITY: argv-based — no shell:true.
 */
export function makeAdbRunner(deviceId?: string): AdbRunner {
  const adbBin = process.env["ADB_PATH"] ?? "adb";
  return async (args: string[]) => {
    const full = deviceId ? ["-s", deviceId, ...args] : args;
    const { stdout } = await pexec(adbBin, full, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  };
}

// ---------- simctl exec ----------

/** Run a simctl command, returns stdout. Shell-safe (argv-based). */
export async function simctlExec(args: string[]): Promise<string> {
  const { stdout } = await pexec("xcrun", ["simctl", ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

// ---------- debuggable gate (Android security invariant P0 #3) ----------

/**
 * Check that a package is marked android:debuggable=true before we try to
 * forward a JDWP port to it. Failing early gives a clear message instead of
 * waiting for the JDWP handshake to time out.
 *
 * Uses `adb shell dumpsys package <pkg>` and looks for "DEBUGGABLE" or
 * pkgFlags that include the 0x2 (FLAG_DEBUGGABLE) bit.
 */
export async function assertAndroidDebuggable(adb: AdbRunner, packageName: string): Promise<void> {
  let output = "";
  try {
    output = await adb(["shell", "dumpsys", "package", packageName]);
  } catch {
    // If dumpsys fails (very old Android / permission denied), don't block —
    // the JDWP handshake itself will reject non-debuggable apps.
    return;
  }
  // Look for the DEBUGGABLE flag in the package flags line:
  //   pkgFlags=[ SYSTEM HAS_CODE ALLOW_CLEAR_USER_DATA ]   (no DEBUGGABLE → not debuggable)
  //   pkgFlags=[ DEBUGGABLE HAS_CODE ... ]
  // Also check for an explicit "debuggable=true" line (some Android versions).
  const hasDebuggableFlag =
    /pkgFlags=\[[^\]]*DEBUGGABLE/i.test(output) ||
    /debuggable=true/i.test(output) ||
    /flags=.*\bDEBUGGABLE\b/i.test(output);

  if (output.includes("Unable to find package") || output.trim() === "") {
    throw new Error(
      `Package "${packageName}" not found on device — is it installed?`,
    );
  }

  // Only block if dumpsys returned package info (non-empty) and the flag is absent.
  if (output.length > 200 && !hasDebuggableFlag) {
    throw new Error(
      `Package "${packageName}" is NOT debuggable (android:debuggable=true missing). ` +
        `Only debug builds are attachable. If this IS a debug build, ensure it is ` +
        `not a release/store variant and rebuild with debuggable=true.`,
    );
  }
}
