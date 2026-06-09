/**
 * Low-level simctl invocation. Centralises the argv-form exec so the host shell
 * (/bin/sh) is never spawned — see SECURITY notes on each helper.
 *
 * No `IosClient` state is involved here; behaviour is parameterised entirely by
 * arguments. Retry / WDA loops live in client.ts and call into these as leaves.
 */

import { execFileSync } from "child_process";
import { classifySimctlError } from "../errors.js";

export const SIMCTL_EXEC_TIMEOUT_MS = 15_000;

interface ExecError {
  killed?: boolean;
  signal?: string;
  stderr?: Buffer | string;
  message?: string;
}

function handleExecError(error: unknown, fullArgs: string[]): never {
  const e = error as ExecError;
  const display = `xcrun ${fullArgs.join(" ")}`;
  if (e.killed === true || e.signal === "SIGTERM") {
    throw new Error(
      `simctl command timed out after ${SIMCTL_EXEC_TIMEOUT_MS}ms: ${display}. Simulator may be unresponsive.`,
    );
  }
  throw classifySimctlError(e.stderr?.toString() ?? e.message ?? String(error), display);
}

/**
 * SECURITY: routes through execFileSync — no /bin/sh -c. Shell metacharacters
 * in `args` are passed as literal argv slots (CWE-78 mitigation, issue #40).
 */
export function execSimctl(args: string[]): string {
  const fullArgs = ["simctl", ...args];
  try {
    return execFileSync("xcrun", fullArgs, {
      encoding: "utf-8",
      timeout: SIMCTL_EXEC_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
    }).trim();
  } catch (error: unknown) {
    handleExecError(error, fullArgs);
  }
}

/**
 * Variant that suppresses stderr (replaces shell `2>/dev/null`).
 * Same security guarantee as execSimctl.
 */
export function execSimctlQuiet(args: string[]): string {
  const fullArgs = ["simctl", ...args];
  try {
    const out = execFileSync("xcrun", fullArgs, {
      encoding: "utf-8",
      timeout: SIMCTL_EXEC_TIMEOUT_MS,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().trim();
  } catch (error: unknown) {
    handleExecError(error, fullArgs);
  }
}
