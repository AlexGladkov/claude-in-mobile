/**
 * Cross-platform binary detection for doctor checks and toolchain resolution.
 * Only bare executable names are accepted. PATH entries are inspected directly;
 * no shell, aliases, functions, or command interpolation participate.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** True on Node's Windows platforms (win32 covers 32- and 64-bit). */
const isWindows = process.platform === "win32";

/**
 * Split the current PATH into directories, dropping empty segments.
 * Accepts an override for testability.
 */
function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  return raw.split(delimiter).filter((d) => d.length > 0);
}

/**
 * Extensions to try when probing a bare name on Windows (`adb` → `adb.exe`,
 * `adb.cmd`, ...). Falls back to the classic set if PATHEXT is unset.
 */
function pathExts(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  // Include the bare name too (in case the token already carries an extension).
  return ["", ...raw.split(";").map((e) => e.trim()).filter((e) => e.length > 0)];
}

/**
 * Resolve a binary on Windows by walking PATH × PATHEXT in argv-form only —
 * no `where.exe`, no shell. Returns the first match or null.
 */
function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichBinWindows(bin: string, env: NodeJS.ProcessEnv): string | null {
  const exts = pathExts(env);
  for (const dir of pathDirs(env)) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (executableFile(candidate)) return candidate;
    }
  }
  return null;
}

function whichBinPosix(bin: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of pathDirs(env)) {
    const candidate = join(dir, bin);
    if (executableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the absolute path of an external binary on PATH, or null if absent.
 * Cross-platform and shell-free (argv-form only). Never throws for the common
 * "binary not found" case; only rethrows genuinely unexpected failures.
 */
export function whichBin(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (
    bin.length === 0
    || bin.length > 128
    || bin.startsWith("-")
    || !/^[A-Za-z0-9._+-]+$/.test(bin)
  ) {
    throw new Error("Binary name must be a safe bare executable name.");
  }
  if (isWindows) return whichBinWindows(bin, env);
  return whichBinPosix(bin, env);
}

/** Convenience predicate: is `bin` present on PATH? */
export function isBinAvailable(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return whichBin(bin, env) !== null;
}
