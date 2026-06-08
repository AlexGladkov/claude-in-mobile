/**
 * Path and process-attach allowlist helpers for the macOS desktop companion.
 *
 * These helpers guard the surface that translates a "launch this app" request
 * into a real process. They intentionally fail closed — anything that cannot
 * be canonically resolved within an allowed directory, or any pid that does
 * not belong to the current user, is rejected before reaching `open` or the
 * companion's attach path.
 */

import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { validatePath } from "../utils/sanitize.js";
import { MobileError } from "../errors.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUNDLE_LAUNCH_POLL_INTERVAL_MS = 100;
const BUNDLE_LAUNCH_TIMEOUT_MS = 5000;

/** Allowed prefixes for appPath (realpath-resolved). */
export const APP_PATH_ALLOWLIST = [
  "/Applications",
  "/System/Applications",
  path.join(os.homedir(), "Applications"),
  "/Developer",
  path.join(os.homedir(), "Library/Developer/Xcode/DerivedData"),
];

/** System processes that must not be attached to. */
export const BLOCKED_COMMS = new Set(["launchd", "kernel_task", "securityd", "loginwindow"]);

/**
 * Resolve bundleId from an .app path by reading Info.plist via `defaults read`.
 * All calls use execFileSync (no shell).
 */
export function getBundleIdFromAppPath(appPath: string): string {
  try {
    const result = execFileSync(
      "defaults",
      ["read", `${appPath}/Contents/Info`, "CFBundleIdentifier"],
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (!result) throw new Error("empty result");
    return result;
  } catch (e: any) {
    throw new MobileError(
      `Could not read bundle ID from ${appPath}/Contents/Info.plist: ${e.message}`,
      "BUNDLE_ID_READ_FAILED"
    );
  }
}

/**
 * Validate an appPath: must be absolute, end with .app, no .., within allowlist (realpath-resolved).
 * Returns the canonicalized path to use when calling `open`.
 */
export function validateAndResolveAppPath(appPath: string): string {
  validatePath(appPath, "appPath");
  if (!path.isAbsolute(appPath)) {
    throw new MobileError(`appPath must be an absolute path: ${appPath}`, "INVALID_APP_PATH");
  }
  if (!appPath.endsWith(".app")) {
    throw new MobileError(`appPath must end with .app: ${appPath}`, "INVALID_APP_PATH");
  }
  const resolved = fs.realpathSync(appPath);
  const allowed = APP_PATH_ALLOWLIST.some(prefix => resolved.startsWith(prefix + "/") || resolved === prefix);
  if (!allowed) {
    throw new MobileError(
      `appPath "${resolved}" is outside allowed directories (${APP_PATH_ALLOWLIST.join(", ")})`,
      "APP_PATH_NOT_ALLOWED"
    );
  }
  return resolved;
}

/**
 * Poll AppleScript until the process with the given bundle ID appears, or timeout.
 * Uses execFileAsync (non-blocking) so the event loop is not held during the 3s osascript call.
 * bundleId is pre-validated by validateBundleId; regex permits only [a-zA-Z0-9.-].
 * AppleScript injection prevention relies on this regex — do not relax without re-auditing.
 */
export async function resolvePidByBundleId(bundleId: string): Promise<number> {
  const deadline = Date.now() + BUNDLE_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(
        "osascript",
        ["-e", `tell application "System Events" to unix id of first application process whose bundle identifier is "${bundleId}"`],
        { timeout: 3000 }
      );
      const pid = parseInt(stdout.trim(), 10);
      if (pid > 0) return pid;
    } catch (e: any) {
      const stderr: string = e.stderr ?? "";
      // Non-transient: permission denial from System Events will never self-resolve
      if (stderr.includes("Not authorized") || stderr.includes("-1743")) {
        throw new MobileError(
          `Accessibility permission denied. Grant access in System Settings → Privacy → Automation.`,
          "AUTOMATION_PERMISSION_DENIED"
        );
      }
      // App not yet running — continue polling
    }
    await new Promise(resolve => setTimeout(resolve, BUNDLE_LAUNCH_POLL_INTERVAL_MS));
  }
  throw new MobileError(
    `App with bundle ID "${bundleId}" did not start within ${BUNDLE_LAUNCH_TIMEOUT_MS}ms`,
    "BUNDLE_LAUNCH_TIMEOUT"
  );
}

/**
 * Validate a PID for safe attach: must be positive, belong to current user, not a system process.
 * Uses separate ps calls to avoid space-split issues with multi-word comm names.
 */
export function validateAttachPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new MobileError(`Invalid pid: ${pid}. Must be a positive integer`, "INVALID_PID");
  }

  let psOut: string;
  try {
    psOut = execFileSync("ps", ["-o", "uid=,comm=", "-p", String(pid)], { encoding: "utf-8" }).trim();
  } catch (e: any) {
    if (e.status === 1) {
      throw new MobileError(`Process with pid ${pid} does not exist`, "PROCESS_NOT_FOUND");
    }
    throw new MobileError(`Failed to inspect pid ${pid}: ${e.message}`, "PS_EXEC_FAILED");
  }

  // uid= and comm= are separated by whitespace; comm= may contain spaces — split on first whitespace only
  const spaceIdx = psOut.search(/\s/);
  const uidStr = spaceIdx >= 0 ? psOut.slice(0, spaceIdx) : psOut;
  const comm = spaceIdx >= 0 ? psOut.slice(spaceIdx + 1).trim() : "";

  const uid = parseInt(uidStr, 10);
  const currentUid = process.getuid ? process.getuid() : -1;
  if (currentUid >= 0 && uid !== currentUid) {
    throw new MobileError(`Cannot attach to pid ${pid}: process belongs to another user`, "PID_FOREIGN_USER");
  }

  const basename = path.basename(comm);
  if (BLOCKED_COMMS.has(basename)) {
    throw new MobileError(`Cannot attach to system process: ${basename} (pid ${pid})`, "PID_SYSTEM_PROCESS");
  }
}

/**
 * Find the companion app path on disk.
 *
 * Two candidate locations are checked: relative to the compiled `dist/desktop/client.js`
 * (production) and relative to the source `src/desktop/client.ts` (when running with ts-node
 * or a similar in-place runner).
 */
export function findCompanionAppPath(): string {
  const possiblePaths = [
    // From dist/desktop/client.js (production layout)
    path.join(__dirname, "..", "..", "desktop-companion", "build", "install", "desktop-companion", "bin", "desktop-companion"),
    // From src/desktop/client.ts (when running directly)
    path.join(__dirname, "..", "..", "..", "desktop-companion", "build", "install", "desktop-companion", "bin", "desktop-companion"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error(
    "Desktop companion app not found. Please build it first: cd desktop-companion && ./gradlew installDist"
  );
}

export { BUNDLE_LAUNCH_POLL_INTERVAL_MS, BUNDLE_LAUNCH_TIMEOUT_MS };
