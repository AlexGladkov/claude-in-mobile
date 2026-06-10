/**
 * Internal execFile wrapper for the build pipeline.
 *
 * SECURITY: everything routes through execFile (argv form) — /bin/sh is never
 * spawned, so shell metacharacters in paths/schemes are literal argv slots
 * (CWE-78 mitigation, same contract as src/ios/simctl-exec.ts and src/adb/exec.ts).
 *
 * Returns a Result instead of throwing: callers need raw stderr to classify
 * (and redact) build failures — see classify-build-error.ts.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** xcodebuild logs are huge; 50 MiB matches the other exec wrappers. */
const MAX_BUFFER = 50 * 1024 * 1024;

export type ToolResult =
  | { ok: true; stdout: string }
  | { ok: false; timedOut: boolean; stderr: string };

interface ExecError {
  killed?: boolean;
  signal?: string;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
  message?: string;
}

export async function runTool(
  file: string,
  args: string[],
  options: { timeoutMs: number; cwd?: string },
): Promise<ToolResult> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      encoding: "utf-8",
      timeout: options.timeoutMs,
      maxBuffer: MAX_BUFFER,
      cwd: options.cwd,
    });
    return { ok: true, stdout: stdout.toString() };
  } catch (error: unknown) {
    const e = error as ExecError;
    const timedOut = e.killed === true || e.signal === "SIGTERM";
    const stderr = e.stderr?.toString() || e.message || String(error);
    return { ok: false, timedOut, stderr };
  }
}
