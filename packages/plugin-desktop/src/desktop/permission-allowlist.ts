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
import { createRequire } from "module";
import { validateBundleId, validatePath } from "mcp-devices/utils/sanitize";
import { MobileError } from "mcp-devices/errors";

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
export const BLOCKED_COMMS: Readonly<Record<string, true>> = {
  launchd: true,
  kernel_task: true,
  securityd: true,
  loginwindow: true,
};

/**
 * Resolve bundleId from an .app path by reading Info.plist via `defaults read`.
 * All calls use execFileSync (no shell).
 */
export function getBundleIdFromAppPath(appPath: string): string {
  const resolved = validateAndResolveAppPath(appPath);
  try {
    const result = execFileSync(
      "/usr/bin/defaults",
      ["read", `${resolved}/Contents/Info`, "CFBundleIdentifier"],
      { encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 1024 }
    ).trim();
    validateBundleId(result);
    return result;
  } catch {
    throw new MobileError(
      "Could not read a valid bundle ID from the application.",
      "BUNDLE_ID_READ_FAILED"
    );
  }
}

/**
 * Validate an appPath: must be absolute, end with .app, no .., within allowlist (realpath-resolved).
 * Returns the canonicalized path to use when calling `open`.
 */
export function validateAndResolveAppPath(appPath: string): string {
  if (appPath.length === 0 || appPath.length > 4096 || appPath.includes("\0")) {
    throw new MobileError("Invalid appPath.", "INVALID_APP_PATH");
  }
  validatePath(appPath, "appPath");
  if (!path.isAbsolute(appPath) || !appPath.endsWith(".app")) {
    throw new MobileError("appPath must be an absolute .app path.", "INVALID_APP_PATH");
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(appPath);
  } catch {
    throw new MobileError("Application path does not exist.", "INVALID_APP_PATH");
  }
  const allowed = APP_PATH_ALLOWLIST.some(
    (prefix) => resolved === prefix || !path.relative(prefix, resolved).startsWith(".."),
  );
  if (!allowed) {
    throw new MobileError(
      "appPath is outside allowed application directories.",
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
  validateBundleId(bundleId);
  const deadline = Date.now() + BUNDLE_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(
        "/usr/bin/osascript",
        ["-e", `tell application "System Events" to unix id of first application process whose bundle identifier is "${bundleId}"`],
        { timeout: 3000, maxBuffer: 64 * 1024 },
      );
      const pid = Number.parseInt(stdout.trim(), 10);
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error: unknown) {
      const stderr = typeof error === "object" && error !== null && "stderr" in error
        ? String(Reflect.get(error, "stderr") ?? "")
        : "";
      if (stderr.includes("Not authorized") || stderr.includes("-1743")) {
        throw new MobileError(
          "Accessibility permission denied. Grant access in System Settings → Privacy → Automation.",
          "AUTOMATION_PERMISSION_DENIED"
        );
      }
      // App not yet running — continue polling
    }
    await new Promise(resolve => setTimeout(resolve, BUNDLE_LAUNCH_POLL_INTERVAL_MS));
  }
  throw new MobileError(
    "Application did not start before the launch deadline.",
    "BUNDLE_LAUNCH_TIMEOUT"
  );
}

/**
 * Validate a PID for safe attach: must be positive, belong to current user, not a system process.
 * Uses separate ps calls to avoid space-split issues with multi-word comm names.
 */
export function validateAttachPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new MobileError("Invalid pid.", "INVALID_PID");
  }

  let psOut: string;
  try {
    psOut = execFileSync(
      "/bin/ps",
      ["-o", "uid=,comm=", "-p", String(pid)],
      { encoding: "utf-8", timeout: 3000, maxBuffer: 64 * 1024 },
    ).trim();
  } catch (error: unknown) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? Reflect.get(error, "status")
      : undefined;
    if (status === 1) {
      throw new MobileError("Process does not exist.", "PROCESS_NOT_FOUND");
    }
    throw new MobileError("Failed to inspect process.", "PS_EXEC_FAILED");
  }

  const spaceIdx = psOut.search(/\s/);
  const uidStr = spaceIdx >= 0 ? psOut.slice(0, spaceIdx) : psOut;
  const comm = spaceIdx >= 0 ? psOut.slice(spaceIdx + 1).trim() : "";
  const uid = Number.parseInt(uidStr, 10);
  const currentUid = process.getuid?.();
  if (currentUid === undefined || !Number.isSafeInteger(uid) || uid < 0 || !comm) {
    throw new MobileError("Process identity could not be verified.", "PS_EXEC_FAILED");
  }
  if (uid !== currentUid) {
    throw new MobileError("Cannot attach to a process owned by another user.", "PID_FOREIGN_USER");
  }

  const basename = path.basename(comm);
  if (Object.hasOwn(BLOCKED_COMMS, basename)) {
    throw new MobileError("Cannot attach to a protected system process.", "PID_SYSTEM_PROCESS");
  }
}

/**
 * Find the companion app in either the plugin package, its `mcp-devices`
 * dependency, or a source checkout.
 */
export function findCompanionAppPath(): string {
  const companionRelativePath = path.join(
    "desktop-companion",
    "build",
    "install",
    "desktop-companion",
    "bin",
    "desktop-companion",
  );
  const mcpDevicesEntry = createRequire(import.meta.url).resolve("mcp-devices");
  const mcpDevicesRoot = path.resolve(path.dirname(mcpDevicesEntry), "..");
  const possiblePaths = [
    path.join(__dirname, "..", "..", companionRelativePath),
    path.join(mcpDevicesRoot, companionRelativePath),
    path.join(__dirname, "..", "..", "..", "..", companionRelativePath),
  ];

  for (const candidate of possiblePaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Desktop companion app not found. Please build it first: cd desktop-companion && ./gradlew installDist"
  );
}


export { BUNDLE_LAUNCH_POLL_INTERVAL_MS, BUNDLE_LAUNCH_TIMEOUT_MS };
