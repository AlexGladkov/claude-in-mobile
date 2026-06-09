import { MobileError } from "./base.js";
import {
  DeviceNotFoundError,
  DeviceOfflineError,
  PermissionDeniedError,
  CommandTimeoutError,
} from "./device.js";

export class AdbNotInstalledError extends MobileError {
  constructor(triedPaths?: string[]) {
    const base = "ADB is not installed or not found.";
    const install = "Install Android SDK or run: brew install android-platform-tools (macOS) / install Android Studio (Windows/Linux)";
    const hint = "Or set ADB_PATH=/path/to/adb to point at a specific binary.";
    const probed = triedPaths && triedPaths.length > 0
      ? `\n\nProbed locations:\n${triedPaths.join("\n")}`
      : "";
    super(`${base}\n\n${install}\n${hint}${probed}`, "ADB_NOT_INSTALLED");
  }
}

/**
 * Classify ADB errors from stderr output
 */
export function classifyAdbError(stderr: string, command: string): MobileError {
  const msg = stderr.toLowerCase();

  if (msg.includes("not found") && (msg.includes("adb") || msg.includes("command"))) {
    return new AdbNotInstalledError();
  }
  if (msg.includes("device not found") || msg.includes("no devices") || msg.includes("device '' not found")) {
    return new DeviceNotFoundError();
  }
  if (msg.includes("device offline") || msg.includes("error: device offline")) {
    return new DeviceOfflineError(command.match(/-s (\S+)/)?.[1] ?? "unknown");
  }
  if (msg.includes("permission denied") || msg.includes("insufficient permissions")) {
    return new PermissionDeniedError(stderr.trim());
  }
  if (msg.includes("timeout") || msg.includes("timed out")) {
    return new CommandTimeoutError(command, 0);
  }

  const cmdType = command.replace(/^adb\s+(-s\s+\S+\s+)?/, "").split(/\s+/)[0] ?? "unknown";
  return new MobileError(`ADB ${cmdType} failed: ${stderr.trim().slice(0, 200)}`, "ADB_ERROR");
}
