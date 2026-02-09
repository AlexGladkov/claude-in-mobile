/**
 * Typed error classes for better error classification and handling.
 * Enables Claude to auto-suggest fixes and enables smart retry logic.
 */
export declare class MobileError extends Error {
    readonly code: string;
    constructor(message: string, code: string);
}
export declare class DeviceNotFoundError extends MobileError {
    constructor(deviceId?: string);
}
export declare class AdbNotInstalledError extends MobileError {
    constructor();
}
export declare class SimctlNotInstalledError extends MobileError {
    constructor();
}
export declare class DeviceOfflineError extends MobileError {
    constructor(deviceId: string);
}
export declare class PermissionDeniedError extends MobileError {
    constructor(detail?: string);
}
export declare class CommandTimeoutError extends MobileError {
    constructor(command: string, timeoutMs: number);
}
export declare class WdaNotInstalledError extends MobileError {
    constructor();
}
export declare class ElementNotFoundError extends MobileError {
    constructor(criteria: string);
}
export declare class WebViewNotFoundError extends MobileError {
    constructor();
}
/**
 * Classify ADB errors from stderr output
 */
export declare function classifyAdbError(stderr: string, command: string): MobileError;
/**
 * Classify simctl errors from stderr output
 */
export declare function classifySimctlError(stderr: string, command: string): MobileError;
//# sourceMappingURL=errors.d.ts.map