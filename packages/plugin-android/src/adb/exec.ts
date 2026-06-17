/**
 * Low-level adb invocation helpers.
 *
 * All public surfaces here go through execFile / execFileSync — never `/bin/sh -c`.
 * Shell metacharacters in `args` are passed as literal argv slots, not parsed by
 * the host shell. This structurally prevents host-side OS Command Injection
 * (CWE-78) — see issue #40.
 */

import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { classifyAdbError } from "claude-in-mobile/errors";
import { resolveAdbPath } from "./resolver.js";

const execFileAsync = promisify(execFile);

/** Default timeout for text adb commands (`shell ...`, `devices`, etc.). */
export const EXEC_TIMEOUT_MS = 15_000;

/** Extended timeout for raw byte adb commands (screenshots, file pulls). */
export const EXEC_RAW_TIMEOUT_MS = 30_000;

/** Cap stdout buffers at 50 MiB — sufficient for a 4K PNG screenshot. */
const MAX_BUFFER = 50 * 1024 * 1024;

/** Build the `-s <id>` argv slice for an optional device override. */
export function deviceArgs(deviceId: string | undefined): string[] {
  return deviceId ? ["-s", deviceId] : [];
}

/** Synchronous text invocation: returns trimmed stdout. */
export function execAdb(args: string[], deviceId: string | undefined): string {
  const adbBin = resolveAdbPath();
  const fullArgs = [...deviceArgs(deviceId), ...args];
  try {
    return execFileSync(adbBin, fullArgs, {
      encoding: "utf-8",
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    }).trim();
  } catch (error: unknown) {
    throw translateExecError(error, fullArgs, EXEC_TIMEOUT_MS);
  }
}

/** Synchronous raw-bytes invocation (e.g. PNG screenshot). */
export function execAdbRaw(args: string[], deviceId: string | undefined): Buffer {
  const adbBin = resolveAdbPath();
  const fullArgs = [...deviceArgs(deviceId), ...args];
  try {
    return execFileSync(adbBin, fullArgs, {
      timeout: EXEC_RAW_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (error: unknown) {
    throw translateExecError(error, fullArgs, EXEC_RAW_TIMEOUT_MS);
  }
}

/** Asynchronous text invocation. */
export async function execAdbAsync(args: string[], deviceId: string | undefined): Promise<string> {
  const adbBin = resolveAdbPath();
  const fullArgs = [...deviceArgs(deviceId), ...args];
  try {
    const { stdout } = await execFileAsync(adbBin, fullArgs, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: "utf-8",
    });
    return stdout.trim();
  } catch (error: unknown) {
    throw translateExecError(error, fullArgs, EXEC_TIMEOUT_MS);
  }
}

/** Asynchronous raw-bytes invocation. */
export async function execAdbRawAsync(args: string[], deviceId: string | undefined): Promise<Buffer> {
  const adbBin = resolveAdbPath();
  const fullArgs = [...deviceArgs(deviceId), ...args];
  try {
    const { stdout } = await execFileAsync(adbBin, fullArgs, {
      timeout: EXEC_RAW_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: "buffer" as BufferEncoding,
    });
    return stdout as unknown as Buffer;
  } catch (error: unknown) {
    throw translateExecError(error, fullArgs, EXEC_RAW_TIMEOUT_MS);
  }
}

/**
 * Convert a child_process error into a typed MobileError (via classifyAdbError) or
 * a clear timeout message. The display string mirrors what a developer would type
 * at a terminal: `adb -s <id> <args>`.
 */
function translateExecError(error: unknown, fullArgs: string[], timeoutMs: number): Error {
  const e = error as { killed?: boolean; signal?: string; stderr?: Buffer | string; message?: string };
  const display = `adb ${fullArgs.join(" ")}`;
  if (e.killed === true || e.signal === "SIGTERM") {
    return new Error(`ADB command timed out after ${timeoutMs}ms: ${display}. Device may be disconnected or screen locked.`);
  }
  return classifyAdbError(e.stderr?.toString() ?? e.message ?? String(error), display);
}
