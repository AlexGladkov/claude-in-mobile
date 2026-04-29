import { describe, it, expect } from "vitest";
import {
  MobileError,
  DeviceNotFoundError,
  AdbNotInstalledError,
  SimctlNotInstalledError,
  DeviceOfflineError,
  PermissionDeniedError,
  CommandTimeoutError,
  WdaNotInstalledError,
  ElementNotFoundError,
  WebViewNotFoundError,
  BrowserSecurityError,
  BrowserSessionNotFoundError,
  BrowserNoSessionError,
  BrowserRefNotFoundError,
  ChromeNotInstalledError,
  ModuleNotLoadedError,
  UnknownActionError,
  ValidationError,
  isRetryable,
  classifyAdbError,
  classifySimctlError,
} from "./errors.js";

// ──────────────────────────────────────────────
// MobileError base class
// ──────────────────────────────────────────────

describe("MobileError", () => {
  it("is an instance of Error", () => {
    const err = new MobileError("test message", "TEST_CODE");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MobileError);
  });

  it("has correct name, message, and code", () => {
    const err = new MobileError("something broke", "SOME_CODE");
    expect(err.name).toBe("MobileError");
    expect(err.message).toBe("something broke");
    expect(err.code).toBe("SOME_CODE");
  });

  it("code is readonly", () => {
    const err = new MobileError("msg", "CODE");
    // TypeScript prevents assignment, but verify the property exists
    expect(err.code).toBe("CODE");
  });
});

// ──────────────────────────────────────────────
// Error subclasses — codes and messages
// ──────────────────────────────────────────────

describe("DeviceNotFoundError", () => {
  it("has DEVICE_NOT_FOUND code", () => {
    const err = new DeviceNotFoundError();
    expect(err.code).toBe("DEVICE_NOT_FOUND");
    expect(err.name).toBe("DeviceNotFoundError");
    expect(err).toBeInstanceOf(MobileError);
  });

  it("includes device ID in message when provided", () => {
    const err = new DeviceNotFoundError("emulator-5554");
    expect(err.message).toContain("emulator-5554");
    expect(err.message).toContain("device(action:'list')");
  });

  it("suggests connecting a device when no ID provided", () => {
    const err = new DeviceNotFoundError();
    expect(err.message).toContain("No device connected");
  });
});

describe("AdbNotInstalledError", () => {
  it("has ADB_NOT_INSTALLED code", () => {
    const err = new AdbNotInstalledError();
    expect(err.code).toBe("ADB_NOT_INSTALLED");
    expect(err.name).toBe("AdbNotInstalledError");
  });

  it("includes install instructions", () => {
    const err = new AdbNotInstalledError();
    expect(err.message).toContain("ADB");
    expect(err.message).toContain("brew install");
  });
});

describe("SimctlNotInstalledError", () => {
  it("has SIMCTL_NOT_INSTALLED code", () => {
    const err = new SimctlNotInstalledError();
    expect(err.code).toBe("SIMCTL_NOT_INSTALLED");
    expect(err.name).toBe("SimctlNotInstalledError");
  });

  it("suggests installing Xcode", () => {
    const err = new SimctlNotInstalledError();
    expect(err.message).toContain("Xcode");
  });
});

describe("DeviceOfflineError", () => {
  it("has DEVICE_OFFLINE code", () => {
    const err = new DeviceOfflineError("emulator-5554");
    expect(err.code).toBe("DEVICE_OFFLINE");
    expect(err.name).toBe("DeviceOfflineError");
  });

  it("includes device ID and recovery steps", () => {
    const err = new DeviceOfflineError("abc123");
    expect(err.message).toContain("abc123");
    expect(err.message).toContain("adb reconnect");
  });
});

describe("PermissionDeniedError", () => {
  it("has PERMISSION_DENIED code", () => {
    const err = new PermissionDeniedError();
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.name).toBe("PermissionDeniedError");
  });

  it("includes detail when provided", () => {
    const err = new PermissionDeniedError("USB debugging off");
    expect(err.message).toContain("USB debugging off");
  });

  it("works without detail", () => {
    const err = new PermissionDeniedError();
    expect(err.message).toContain("Permission denied");
    expect(err.message).toContain("USB debugging");
  });
});

describe("CommandTimeoutError", () => {
  it("has COMMAND_TIMEOUT code", () => {
    const err = new CommandTimeoutError("adb shell ls", 5000);
    expect(err.code).toBe("COMMAND_TIMEOUT");
    expect(err.name).toBe("CommandTimeoutError");
  });

  it("includes timeout duration in message", () => {
    const err = new CommandTimeoutError("cmd", 30000);
    expect(err.message).toContain("30000ms");
  });
});

describe("WdaNotInstalledError", () => {
  it("has WDA_NOT_INSTALLED code", () => {
    const err = new WdaNotInstalledError();
    expect(err.code).toBe("WDA_NOT_INSTALLED");
    expect(err.name).toBe("WdaNotInstalledError");
  });

  it("includes install instructions", () => {
    const err = new WdaNotInstalledError();
    expect(err.message).toContain("WebDriverAgent");
    expect(err.message).toContain("appium");
  });
});

describe("ElementNotFoundError", () => {
  it("has ELEMENT_NOT_FOUND code", () => {
    const err = new ElementNotFoundError("text=Login");
    expect(err.code).toBe("ELEMENT_NOT_FOUND");
    expect(err.name).toBe("ElementNotFoundError");
  });

  it("includes search criteria in message", () => {
    const err = new ElementNotFoundError("resourceId=btn_submit");
    expect(err.message).toContain("resourceId=btn_submit");
  });
});

describe("WebViewNotFoundError", () => {
  it("has WEBVIEW_NOT_FOUND code", () => {
    const err = new WebViewNotFoundError();
    expect(err.code).toBe("WEBVIEW_NOT_FOUND");
    expect(err.name).toBe("WebViewNotFoundError");
  });
});

describe("BrowserSecurityError", () => {
  it("has BROWSER_SECURITY code", () => {
    const err = new BrowserSecurityError("javascript:alert(1)", "javascript:");
    expect(err.code).toBe("BROWSER_SECURITY");
    expect(err.name).toBe("BrowserSecurityError");
  });

  it("includes blocked URL and protocol", () => {
    const err = new BrowserSecurityError("file:///etc/passwd", "file:");
    expect(err.message).toContain("file:///etc/passwd");
    expect(err.message).toContain("file:");
  });
});

describe("BrowserSessionNotFoundError", () => {
  it("has BROWSER_SESSION_NOT_FOUND code", () => {
    const err = new BrowserSessionNotFoundError("mysession", ["default"]);
    expect(err.code).toBe("BROWSER_SESSION_NOT_FOUND");
    expect(err.name).toBe("BrowserSessionNotFoundError");
  });

  it("lists active sessions when available", () => {
    const err = new BrowserSessionNotFoundError("stale", ["session1", "session2"]);
    expect(err.message).toContain("stale");
    expect(err.message).toContain("session1, session2");
  });

  it("handles empty active session list", () => {
    const err = new BrowserSessionNotFoundError("gone", []);
    expect(err.message).toContain("gone");
    expect(err.message).toContain("browser(action:'open')");
  });
});

describe("BrowserNoSessionError", () => {
  it("has BROWSER_NO_SESSION code", () => {
    const err = new BrowserNoSessionError();
    expect(err.code).toBe("BROWSER_NO_SESSION");
    expect(err.name).toBe("BrowserNoSessionError");
  });

  it("suggests browser(action:'open')", () => {
    const err = new BrowserNoSessionError();
    expect(err.message).toContain("browser(action:'open'");
  });
});

describe("BrowserRefNotFoundError", () => {
  it("has BROWSER_REF_NOT_FOUND code", () => {
    const err = new BrowserRefNotFoundError("e15");
    expect(err.code).toBe("BROWSER_REF_NOT_FOUND");
    expect(err.name).toBe("BrowserRefNotFoundError");
  });

  it("includes ref in message", () => {
    const err = new BrowserRefNotFoundError("e42");
    expect(err.message).toContain("e42");
    expect(err.message).toContain("browser(action:'snapshot')");
  });

  it("includes lastKnown when provided", () => {
    const err = new BrowserRefNotFoundError("e10", "Submit Button");
    expect(err.message).toContain("Submit Button");
  });

  it("works without lastKnown", () => {
    const err = new BrowserRefNotFoundError("e10");
    expect(err.message).not.toContain("was:");
  });
});

describe("ChromeNotInstalledError", () => {
  it("has CHROME_NOT_INSTALLED code", () => {
    const err = new ChromeNotInstalledError();
    expect(err.code).toBe("CHROME_NOT_INSTALLED");
    expect(err.name).toBe("ChromeNotInstalledError");
  });

  it("includes install link", () => {
    const err = new ChromeNotInstalledError();
    expect(err.message).toContain("chrome");
  });
});

describe("ModuleNotLoadedError", () => {
  it("has MODULE_NOT_LOADED code", () => {
    const err = new ModuleNotLoadedError("browser");
    expect(err.code).toBe("MODULE_NOT_LOADED");
    expect(err.name).toBe("ModuleNotLoadedError");
  });

  it("includes module name and enable suggestion", () => {
    const err = new ModuleNotLoadedError("desktop");
    expect(err.message).toContain("desktop");
    expect(err.message).toContain("enable_module");
    expect(err.message).toContain("desktop");
  });
});

describe("UnknownActionError", () => {
  it("has UNKNOWN_ACTION code", () => {
    const err = new UnknownActionError("device", "fly", ["start", "stop", "status"]);
    expect(err.code).toBe("UNKNOWN_ACTION");
    expect(err.name).toBe("UnknownActionError");
  });

  it("formats action list correctly", () => {
    const err = new UnknownActionError("store", "hack", ["list", "search", "install"]);
    expect(err.message).toContain("hack");
    expect(err.message).toContain("store");
    expect(err.message).toContain("list, search, install");
  });

  it("includes tool name in message", () => {
    const err = new UnknownActionError("browser", "destroy", ["open", "close"]);
    expect(err.message).toContain("browser");
  });
});

describe("ValidationError", () => {
  it("has VALIDATION_ERROR code", () => {
    const err = new ValidationError("x must be positive");
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.name).toBe("ValidationError");
  });

  it("passes through custom message", () => {
    const err = new ValidationError("coordinates out of bounds");
    expect(err.message).toBe("coordinates out of bounds");
  });
});

// ──────────────────────────────────────────────
// isRetryable
// ──────────────────────────────────────────────

describe("isRetryable", () => {
  it("returns true for DEVICE_OFFLINE", () => {
    expect(isRetryable(new DeviceOfflineError("dev1"))).toBe(true);
  });

  it("returns true for COMMAND_TIMEOUT", () => {
    expect(isRetryable(new CommandTimeoutError("cmd", 5000))).toBe(true);
  });

  it("returns true for ADB_ERROR", () => {
    expect(isRetryable(new MobileError("adb failed", "ADB_ERROR"))).toBe(true);
  });

  it("returns false for BROWSER_REF_NOT_FOUND (handled by stable ref fallback)", () => {
    expect(isRetryable(new BrowserRefNotFoundError("e1"))).toBe(false);
  });

  it("returns false for DEVICE_NOT_FOUND", () => {
    expect(isRetryable(new DeviceNotFoundError())).toBe(false);
  });

  it("returns false for ADB_NOT_INSTALLED", () => {
    expect(isRetryable(new AdbNotInstalledError())).toBe(false);
  });

  it("returns false for SIMCTL_NOT_INSTALLED", () => {
    expect(isRetryable(new SimctlNotInstalledError())).toBe(false);
  });

  it("returns false for PERMISSION_DENIED", () => {
    expect(isRetryable(new PermissionDeniedError())).toBe(false);
  });

  it("returns false for ELEMENT_NOT_FOUND", () => {
    expect(isRetryable(new ElementNotFoundError("text=X"))).toBe(false);
  });

  it("returns false for WEBVIEW_NOT_FOUND", () => {
    expect(isRetryable(new WebViewNotFoundError())).toBe(false);
  });

  it("returns false for BROWSER_SECURITY", () => {
    expect(isRetryable(new BrowserSecurityError("x", "y"))).toBe(false);
  });

  it("returns false for BROWSER_SESSION_NOT_FOUND", () => {
    expect(isRetryable(new BrowserSessionNotFoundError("s", []))).toBe(false);
  });

  it("returns false for BROWSER_NO_SESSION", () => {
    expect(isRetryable(new BrowserNoSessionError())).toBe(false);
  });

  it("returns false for CHROME_NOT_INSTALLED", () => {
    expect(isRetryable(new ChromeNotInstalledError())).toBe(false);
  });

  it("returns false for MODULE_NOT_LOADED", () => {
    expect(isRetryable(new ModuleNotLoadedError("browser"))).toBe(false);
  });

  it("returns false for UNKNOWN_ACTION", () => {
    expect(isRetryable(new UnknownActionError("tool", "act", ["a"]))).toBe(false);
  });

  it("returns false for VALIDATION_ERROR", () => {
    expect(isRetryable(new ValidationError("bad input"))).toBe(false);
  });

  it("returns false for WDA_NOT_INSTALLED", () => {
    expect(isRetryable(new WdaNotInstalledError())).toBe(false);
  });

  it("returns false for non-MobileError objects", () => {
    expect(isRetryable(new Error("generic error"))).toBe(false);
    expect(isRetryable("string error")).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable(42)).toBe(false);
  });

  it("returns false for plain object with code property", () => {
    expect(isRetryable({ code: "DEVICE_OFFLINE", message: "fake" })).toBe(false);
  });
});

// ──────────────────────────────────────────────
// classifyAdbError
// ──────────────────────────────────────────────

describe("classifyAdbError", () => {
  it("returns AdbNotInstalledError for 'adb not found'", () => {
    const err = classifyAdbError("adb: command not found", "adb devices");
    expect(err).toBeInstanceOf(AdbNotInstalledError);
    expect(err.code).toBe("ADB_NOT_INSTALLED");
  });

  it("returns AdbNotInstalledError for 'command not found'", () => {
    const err = classifyAdbError("bash: adb: command not found", "adb shell ls");
    expect(err).toBeInstanceOf(AdbNotInstalledError);
    expect(err.code).toBe("ADB_NOT_INSTALLED");
  });

  it("returns DeviceNotFoundError for 'device not found'", () => {
    const err = classifyAdbError("error: device not found", "adb -s emulator-5554 shell ls");
    expect(err).toBeInstanceOf(DeviceNotFoundError);
    expect(err.code).toBe("DEVICE_NOT_FOUND");
  });

  it("returns DeviceNotFoundError for 'no devices'", () => {
    const err = classifyAdbError("error: no devices/emulators found", "adb shell ls");
    expect(err).toBeInstanceOf(DeviceNotFoundError);
    expect(err.code).toBe("DEVICE_NOT_FOUND");
  });

  it("returns DeviceNotFoundError for empty device ID 'device '' not found'", () => {
    const err = classifyAdbError("error: device '' not found", "adb shell pm list");
    expect(err).toBeInstanceOf(DeviceNotFoundError);
    expect(err.code).toBe("DEVICE_NOT_FOUND");
  });

  it("returns DeviceOfflineError for 'device offline'", () => {
    const err = classifyAdbError("error: device offline", "adb -s abc123 shell ls");
    expect(err).toBeInstanceOf(DeviceOfflineError);
    expect(err.code).toBe("DEVICE_OFFLINE");
  });

  it("extracts device ID from -s flag for offline error", () => {
    const err = classifyAdbError("error: device offline", "adb -s emulator-5554 shell ls");
    expect(err.message).toContain("emulator-5554");
  });

  it("uses 'unknown' when device ID not found in command", () => {
    const err = classifyAdbError("error: device offline", "adb shell ls");
    expect(err.message).toContain("unknown");
  });

  it("returns PermissionDeniedError for 'permission denied'", () => {
    const err = classifyAdbError("error: permission denied", "adb shell su");
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(err.code).toBe("PERMISSION_DENIED");
  });

  it("returns PermissionDeniedError for 'insufficient permissions'", () => {
    const err = classifyAdbError("error: insufficient permissions for device", "adb devices");
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(err.code).toBe("PERMISSION_DENIED");
  });

  it("returns CommandTimeoutError for 'timeout'", () => {
    const err = classifyAdbError("error: connection timeout", "adb shell monkey");
    expect(err).toBeInstanceOf(CommandTimeoutError);
    expect(err.code).toBe("COMMAND_TIMEOUT");
  });

  it("returns CommandTimeoutError for 'timed out'", () => {
    const err = classifyAdbError("error: operation timed out", "adb install app.apk");
    expect(err).toBeInstanceOf(CommandTimeoutError);
    expect(err.code).toBe("COMMAND_TIMEOUT");
  });

  it("returns generic ADB_ERROR for unrecognized stderr", () => {
    const err = classifyAdbError("error: something completely unexpected", "adb shell dumpsys");
    expect(err).toBeInstanceOf(MobileError);
    expect(err.code).toBe("ADB_ERROR");
  });

  it("generic error includes command type in message", () => {
    const err = classifyAdbError("unknown failure", "adb shell ls -la");
    expect(err.message).toContain("ADB");
    expect(err.message).toContain("shell");
  });

  it("generic error includes command type from -s prefixed command", () => {
    const err = classifyAdbError("unknown failure", "adb -s device123 install app.apk");
    expect(err.message).toContain("install");
  });

  it("generic error truncates long stderr to 200 chars", () => {
    const longStderr = "x".repeat(500);
    const err = classifyAdbError(longStderr, "adb shell ls");
    // Message should contain at most 200 chars of the stderr
    expect(err.message.length).toBeLessThan(300); // accounts for prefix text
  });

  it("is case insensitive for pattern matching", () => {
    const err = classifyAdbError("ERROR: DEVICE NOT FOUND", "adb shell ls");
    expect(err).toBeInstanceOf(DeviceNotFoundError);
  });
});

// ──────────────────────────────────────────────
// classifySimctlError
// ──────────────────────────────────────────────

describe("classifySimctlError", () => {
  it("returns SimctlNotInstalledError for 'unable to find utility'", () => {
    const err = classifySimctlError(
      "xcrun: error: unable to find utility \"simctl\", not a developer tool",
      "xcrun simctl list"
    );
    expect(err).toBeInstanceOf(SimctlNotInstalledError);
    expect(err.code).toBe("SIMCTL_NOT_INSTALLED");
  });

  it("returns DeviceNotFoundError for 'invalid device'", () => {
    const err = classifySimctlError(
      "Invalid device: AAAAA-BBBB-CCCC",
      "xcrun simctl boot AAAAA-BBBB-CCCC"
    );
    expect(err).toBeInstanceOf(DeviceNotFoundError);
    expect(err.code).toBe("DEVICE_NOT_FOUND");
  });

  it("returns DeviceNotFoundError for 'device not found'", () => {
    const err = classifySimctlError(
      "Device not found: iPhone-15-Pro",
      "xcrun simctl boot iPhone-15-Pro"
    );
    expect(err).toBeInstanceOf(DeviceNotFoundError);
    expect(err.code).toBe("DEVICE_NOT_FOUND");
  });

  it("returns CommandTimeoutError for 'timed out'", () => {
    const err = classifySimctlError(
      "Operation timed out waiting for device to boot",
      "xcrun simctl boot 12345"
    );
    expect(err).toBeInstanceOf(CommandTimeoutError);
    expect(err.code).toBe("COMMAND_TIMEOUT");
  });

  it("returns generic SIMCTL_ERROR for unrecognized stderr", () => {
    const err = classifySimctlError(
      "some weird simctl error",
      "xcrun simctl statusbar 12345"
    );
    expect(err).toBeInstanceOf(MobileError);
    expect(err.code).toBe("SIMCTL_ERROR");
  });

  it("generic error includes command type in message", () => {
    const err = classifySimctlError(
      "failed somehow",
      "xcrun simctl install UDID app.app"
    );
    expect(err.message).toContain("simctl");
    expect(err.message).toContain("install");
  });

  it("generic error truncates long stderr to 200 chars", () => {
    const longStderr = "y".repeat(500);
    const err = classifySimctlError(longStderr, "xcrun simctl list");
    expect(err.message.length).toBeLessThan(300);
  });

  it("is case insensitive for pattern matching", () => {
    const err = classifySimctlError(
      "INVALID DEVICE: test-uuid",
      "xcrun simctl boot test-uuid"
    );
    expect(err).toBeInstanceOf(DeviceNotFoundError);
  });
});

// ──────────────────────────────────────────────
// Error subclasses — isRetryable comprehensive
// ──────────────────────────────────────────────

describe("Error subclasses isRetryable consistency", () => {
  it("DeviceNotFoundError is NOT retryable", () => {
    const err = new DeviceNotFoundError();
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("DEVICE_NOT_FOUND");
    expect(err.name).toBe("DeviceNotFoundError");
  });

  it("DeviceOfflineError IS retryable", () => {
    const err = new DeviceOfflineError("dev1");
    expect(isRetryable(err)).toBe(true);
    expect(err.code).toBe("DEVICE_OFFLINE");
    expect(err.name).toBe("DeviceOfflineError");
  });

  it("ElementNotFoundError is NOT retryable", () => {
    const err = new ElementNotFoundError("text=Login");
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("ELEMENT_NOT_FOUND");
    expect(err.name).toBe("ElementNotFoundError");
  });

  it("BrowserNoSessionError is NOT retryable", () => {
    const err = new BrowserNoSessionError();
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("BROWSER_NO_SESSION");
    expect(err.name).toBe("BrowserNoSessionError");
  });

  it("BrowserSecurityError is NOT retryable", () => {
    const err = new BrowserSecurityError("javascript:alert(1)", "javascript:");
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("BROWSER_SECURITY");
    expect(err.name).toBe("BrowserSecurityError");
  });

  it("ValidationError is NOT retryable", () => {
    const err = new ValidationError("bad input");
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.name).toBe("ValidationError");
  });

  it("ModuleNotLoadedError is NOT retryable", () => {
    const err = new ModuleNotLoadedError("browser");
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("MODULE_NOT_LOADED");
    expect(err.name).toBe("ModuleNotLoadedError");
  });

  it("AdbNotInstalledError is NOT retryable", () => {
    const err = new AdbNotInstalledError();
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("ADB_NOT_INSTALLED");
    expect(err.name).toBe("AdbNotInstalledError");
  });

  it("SimctlNotInstalledError is NOT retryable", () => {
    const err = new SimctlNotInstalledError();
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("SIMCTL_NOT_INSTALLED");
    expect(err.name).toBe("SimctlNotInstalledError");
  });

  it("PermissionDeniedError is NOT retryable", () => {
    const err = new PermissionDeniedError();
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.name).toBe("PermissionDeniedError");
  });

  it("CommandTimeoutError IS retryable (via COMMAND_TIMEOUT code)", () => {
    const err = new CommandTimeoutError("cmd", 5000);
    expect(isRetryable(err)).toBe(true);
    expect(err.code).toBe("COMMAND_TIMEOUT");
    expect(err.name).toBe("CommandTimeoutError");
  });

  it("WdaNotInstalledError is NOT retryable", () => {
    const err = new WdaNotInstalledError();
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("WDA_NOT_INSTALLED");
    expect(err.name).toBe("WdaNotInstalledError");
  });

  it("WebViewNotFoundError is NOT retryable", () => {
    const err = new WebViewNotFoundError();
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("WEBVIEW_NOT_FOUND");
    expect(err.name).toBe("WebViewNotFoundError");
  });

  it("BrowserSessionNotFoundError is NOT retryable", () => {
    const err = new BrowserSessionNotFoundError("s", []);
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("BROWSER_SESSION_NOT_FOUND");
    expect(err.name).toBe("BrowserSessionNotFoundError");
  });

  it("BrowserRefNotFoundError is NOT retryable (handled by stable ref fallback)", () => {
    const err = new BrowserRefNotFoundError("e1");
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("BROWSER_REF_NOT_FOUND");
    expect(err.name).toBe("BrowserRefNotFoundError");
  });

  it("ChromeNotInstalledError is NOT retryable", () => {
    const err = new ChromeNotInstalledError();
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("CHROME_NOT_INSTALLED");
    expect(err.name).toBe("ChromeNotInstalledError");
  });

  it("UnknownActionError is NOT retryable", () => {
    const err = new UnknownActionError("tool", "act", ["a"]);
    expect(isRetryable(err)).toBe(false);
    expect(err.code).toBe("UNKNOWN_ACTION");
    expect(err.name).toBe("UnknownActionError");
  });
});

// ──────────────────────────────────────────────
// Error messages reference v3.4 tool names
// ──────────────────────────────────────────────

describe("Error messages reference v3.4 tool names", () => {
  it("ElementNotFoundError references ui(action:'tree')", () => {
    const err = new ElementNotFoundError("text=Login");
    expect(err.message).toContain("ui(action:'tree')");
  });

  it("BrowserNoSessionError references browser(action:'open')", () => {
    const err = new BrowserNoSessionError();
    expect(err.message).toContain("browser(action:'open'");
  });

  it("DeviceNotFoundError references device(action:'list')", () => {
    const err = new DeviceNotFoundError("emulator-5554");
    expect(err.message).toContain("device(action:'list')");
  });

  it("BrowserRefNotFoundError references browser(action:'snapshot')", () => {
    const err = new BrowserRefNotFoundError("e42");
    expect(err.message).toContain("browser(action:'snapshot')");
  });

  it("BrowserSessionNotFoundError references browser(action:'open')", () => {
    const err = new BrowserSessionNotFoundError("gone", []);
    expect(err.message).toContain("browser(action:'open')");
  });

  it("ModuleNotLoadedError references device(action:'enable_module')", () => {
    const err = new ModuleNotLoadedError("desktop");
    expect(err.message).toContain("enable_module");
    expect(err.message).toContain("desktop");
  });

  it("ElementNotFoundError references ui(action:'analyze')", () => {
    const err = new ElementNotFoundError("text=Login");
    expect(err.message).toContain("ui(action:'analyze')");
  });
});
