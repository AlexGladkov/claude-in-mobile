import { MobileError } from "./base.js";
import { DeviceNotFoundError, CommandTimeoutError } from "./device.js";

export class SimctlNotInstalledError extends MobileError {
  constructor() {
    super(
      "xcrun simctl is not available.\n\nInstall Xcode from the App Store.",
      "SIMCTL_NOT_INSTALLED"
    );
  }
}

export class WdaNotInstalledError extends MobileError {
  constructor() {
    super(
      "WebDriverAgent not found.\n\nInstall: npm install -g appium && appium driver install xcuitest\nOr set WDA_PATH environment variable.",
      "WDA_NOT_INSTALLED"
    );
  }
}

/**
 * Classify simctl errors from stderr output
 */
export function classifySimctlError(stderr: string, command: string): MobileError {
  const msg = stderr.toLowerCase();

  if (msg.includes("xcrun: error: unable to find utility")) {
    return new SimctlNotInstalledError();
  }
  if (msg.includes("invalid device") || msg.includes("device not found")) {
    return new DeviceNotFoundError();
  }
  if (msg.includes("timed out")) {
    return new CommandTimeoutError(command, 0);
  }

  const cmdType = command.replace(/^xcrun\s+simctl\s+/, "").split(/\s+/)[0] ?? "unknown";
  return new MobileError(`simctl ${cmdType} failed: ${stderr.trim().slice(0, 200)}`, "SIMCTL_ERROR");
}
