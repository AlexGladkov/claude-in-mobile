/**
 * Cross-platform binary detection — the single source of truth for "is this
 * external CLI on PATH?" used by `doctor`, platform resolvers, and toolchain
 * auto-detect (e.g. JAVA_HOME).
 *
 * SECURITY (CWE-78) — this MUST stay argv-form. We never spawn a shell:
 *   - no `execFileSync("/bin/sh", ["-c", ...])`
 *   - no `{ shell: true }`
 *   - no `cmd /c`
 * On Windows `/bin/sh` is absent, so the old `command -v` approach reported
 * every probe MISSING regardless of PATH. Here we resolve PATH ourselves on
 * win32 (honouring PATHEXT) and defer to `command -v` (a POSIX shell builtin,
 * invoked in argv form with a fixed arg vector) only on unix.
 *
 * `bin` is always a fixed allowlisted token (see TOOLCHAIN) — but because this
 * is the shared choke point we still pass it as a discrete argv element and
 * never interpolate it into a shell string, so a future caller with a
 * less-trusted `bin` cannot inject.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
function whichBinWindows(bin: string, env: NodeJS.ProcessEnv): string | null {
  const exts = pathExts(env);
  for (const dir of pathDirs(env)) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve a binary on POSIX via `command -v` — a shell BUILTIN, so we invoke
 * the shell in argv form (`sh -c 'command -v --' <bin>`) where `<bin>` is a
 * discrete $0/positional argument, never spliced into the script string.
 * Returns the resolved path or null.
 *
 * Distinguishes "shell itself missing" (unexpected — rethrown) from "binary
 * not found" (exit status 1 — the normal negative answer).
 */
function whichBinPosix(bin: string): string | null {
  try {
    // `command -v -- "$1"` with bin passed positionally: no interpolation.
    const out = execFileSync("/bin/sh", ["-c", 'command -v -- "$1"', "sh", bin], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    return out.length > 0 ? out : null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // /bin/sh missing/unspawnable — genuinely unexpected on POSIX; surface it
    // rather than silently reporting the binary as absent.
    if (e.code === "ENOENT") {
      throw new Error("whichBin: /bin/sh not found — cannot probe PATH", { cause: err });
    }
    // Non-zero exit (status 1) = binary not on PATH. That is the normal
    // "not found" answer, not an error.
    return null;
  }
}

/**
 * Resolve the absolute path of an external binary on PATH, or null if absent.
 * Cross-platform and shell-free (argv-form only). Never throws for the common
 * "binary not found" case; only rethrows genuinely unexpected failures.
 */
export function whichBin(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isWindows) return whichBinWindows(bin, env);
  return whichBinPosix(bin);
}

/** Convenience predicate: is `bin` present on PATH? */
export function isBinAvailable(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return whichBin(bin, env) !== null;
}
