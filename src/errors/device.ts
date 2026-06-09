import { MobileError } from "./base.js";

export class DeviceNotFoundError extends MobileError {
  constructor(deviceId?: string) {
    super(
      deviceId
        ? `Device not found: ${deviceId}. Use device(action:'list') to see connected devices.`
        : "No device connected. Connect a device or start an emulator.",
      "DEVICE_NOT_FOUND"
    );
  }
}

export class DeviceOfflineError extends MobileError {
  constructor(deviceId: string) {
    super(
      `Device ${deviceId} is offline. Try:\n  adb reconnect\n  adb kill-server && adb start-server`,
      "DEVICE_OFFLINE"
    );
  }
}

export class PermissionDeniedError extends MobileError {
  constructor(detail?: string) {
    super(
      `Permission denied${detail ? `: ${detail}` : ""}. Check USB debugging is enabled.`,
      "PERMISSION_DENIED"
    );
  }
}

export class CommandTimeoutError extends MobileError {
  constructor(_command: string, timeoutMs: number) {
    super(
      `Command timed out after ${timeoutMs}ms`,
      "COMMAND_TIMEOUT"
    );
  }
}

export class ModuleNotLoadedError extends MobileError {
  constructor(moduleName: string) {
    super(
      `Module "${moduleName}" is not loaded. Use device(action:'enable_module', module:'${moduleName}') to enable it.`,
      "MODULE_NOT_LOADED"
    );
  }
}
