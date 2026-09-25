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
import { classifyAdbError } from "mcp-devices/errors";
import { resolveAdbPath } from "./resolver.js";

const execFileAsync = promisify(execFile);

/** Default timeout for text adb commands (`shell ...`, `devices`, etc.). */
export const EXEC_TIMEOUT_MS = 15_000;

/** Extended timeout for raw byte adb commands (screenshots, file pulls). */
export const EXEC_RAW_TIMEOUT_MS = 30_000;
export const EXEC_TRANSFER_TIMEOUT_MS = 120_000;

/** Cap stdout buffers at 50 MiB — sufficient for a 4K PNG screenshot. */
const MAX_BUFFER = 50 * 1024 * 1024;
const SAFE_ADB_COMMANDS = new Set([
  "bugreport", "connect", "devices", "disconnect", "emu", "exec-out", "forward",
  "get-serialno", "install", "install-multiple", "kill-server", "logcat", "pair",
  "pull", "push", "reboot", "remount", "reverse", "root", "shell", "start-server",
  "tcpip", "uninstall", "unroot", "version", "wait-for-device",
]);

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
export async function execAdbAsync(
  args: string[],
  deviceId: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("ADB command was cancelled.");
  }
  const adbBin = resolveAdbPath();
  const fullArgs = [...deviceArgs(deviceId), ...args];
  try {
    const { stdout } = await execFileAsync(adbBin, fullArgs, {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      encoding: "utf-8",
      signal,
    });
    return stdout.trim();
  } catch (error: unknown) {
    if (signal?.aborted) throw signal.reason ?? error;
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

/** Long-running adb command that writes payload directly to a caller-controlled file path. */
export async function execAdbFileTransfer(args: string[], deviceId: string | undefined): Promise<string> {
  const adbBin = resolveAdbPath();
  const fullArgs = [...deviceArgs(deviceId), ...args];
  try {
    const { stdout } = await execFileAsync(adbBin, fullArgs, {
      timeout: EXEC_TRANSFER_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: "utf-8",
    });
    return stdout.trim();
  } catch (error: unknown) {
    throw translateExecError(error, fullArgs, EXEC_TRANSFER_TIMEOUT_MS);
  }
}

/**
 * Return a diagnostic label without exposing arbitrary argv values. ADB args
 * can contain text, URLs, clipboard contents, and file paths supplied by the
 * caller; only the fixed top-level verb is safe to include in an error.
 */
function displayAdbCommand(fullArgs: string[]): string {
  const commandIndex = fullArgs[0] === "-s" ? 2 : 0;
  const command = fullArgs[commandIndex];
  return `adb ${command && SAFE_ADB_COMMANDS.has(command) ? command : "command"}`;
}

/** Convert a child_process error into a typed MobileError (via classifyAdbError) or
 * a clear timeout message, with no caller-controlled argv in its display string. */
function translateExecError(error: unknown, fullArgs: string[], timeoutMs: number): Error {
  const e = error as { killed?: boolean; signal?: string; stderr?: Buffer | string; message?: string };
  const display = displayAdbCommand(fullArgs);
  if (e.killed === true || e.signal === "SIGTERM") {
    return new Error(`ADB command timed out after ${timeoutMs}ms: ${display}. Device may be disconnected or screen locked.`);
  }
  return classifyAdbError(e.stderr?.toString() ?? e.message ?? String(error), display);
}
