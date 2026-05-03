/**
 * Resolves the path to the `adb` binary.
 *
 * Priority:
 *   1. ADB_PATH env var (explicit override)
 *   2. ANDROID_HOME / ANDROID_SDK_ROOT env vars + /platform-tools/adb[.exe]
 *   3. Platform-default SDK locations (Android Studio defaults)
 *   4. `adb` from PATH (fallback — works when adb is on PATH, e.g. macOS Homebrew)
 *
 * Result is memoized: the first call probes the filesystem, subsequent calls
 * return the cached path. Tests call `_resetCacheForTests()` to clear it.
 *
 * Throws AdbNotInstalledError with the list of probed paths when nothing works.
 */

import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { AdbNotInstalledError } from "../errors.js";

let cachedPath: string | null = null;
let resolved = false;

const isWin = platform() === "win32";
const adbBinary = isWin ? "adb.exe" : "adb";

/** Build candidate paths in priority order; first existing wins. */
function buildCandidates(): { path: string; source: string }[] {
  const candidates: { path: string; source: string }[] = [];

  // 1. Explicit override
  if (process.env.ADB_PATH) {
    candidates.push({ path: process.env.ADB_PATH, source: "ADB_PATH" });
  }

  // 2. Android SDK env vars (ANDROID_HOME first; ANDROID_SDK_ROOT is the newer name but both are common)
  for (const envVar of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const root = process.env[envVar];
    if (root) {
      candidates.push({
        path: join(root, "platform-tools", adbBinary),
        source: `${envVar}/platform-tools`,
      });
    }
  }

  // 3. Platform defaults — where Android Studio installs the SDK by default
  const home = homedir();
  if (isWin) {
    // %LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe
    const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    candidates.push({
      path: join(localAppData, "Android", "Sdk", "platform-tools", adbBinary),
      source: "LOCALAPPDATA/Android/Sdk",
    });
  } else if (platform() === "darwin") {
    candidates.push({
      path: join(home, "Library", "Android", "sdk", "platform-tools", adbBinary),
      source: "~/Library/Android/sdk",
    });
  } else {
    // linux + others: ~/Android/Sdk is Android Studio default on Linux
    candidates.push({
      path: join(home, "Android", "Sdk", "platform-tools", adbBinary),
      source: "~/Android/Sdk",
    });
  }

  return candidates;
}

/** Check if `adb` is on PATH by asking the shell to locate it. */
function adbOnPath(): boolean {
  try {
    // `where` on Windows, `command -v` on Unix — both exit 0 only on success.
    const cmd = isWin ? "where adb" : "command -v adb";
    execSync(cmd, { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the adb binary path. Memoized after first successful call.
 * Throws AdbNotInstalledError listing all probed paths when nothing is found.
 */
export function resolveAdbPath(): string {
  if (resolved && cachedPath !== null) return cachedPath;

  const candidates = buildCandidates();
  const tried: string[] = [];

  for (const { path, source } of candidates) {
    tried.push(`  - ${source}: ${path}`);
    if (existsSync(path)) {
      cachedPath = path;
      resolved = true;
      return path;
    }
  }

  // Last resort: bare `adb` on PATH
  tried.push("  - PATH: adb");
  if (adbOnPath()) {
    cachedPath = "adb";
    resolved = true;
    return "adb";
  }

  throw new AdbNotInstalledError(tried);
}

/** Quote a path for safe inclusion in a shell command (handles spaces in Windows paths). */
export function quoteAdbPath(path: string): string {
  // Bare `adb` doesn't need quoting; full paths might contain spaces (e.g. "Program Files").
  if (path === "adb" || path === "adb.exe") return path;
  if (path.startsWith('"') && path.endsWith('"')) return path;
  return `"${path}"`;
}

/** @internal — for tests only */
export function _resetCacheForTests(): void {
  cachedPath = null;
  resolved = false;
}
