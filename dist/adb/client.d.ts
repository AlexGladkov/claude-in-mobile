export interface Device {
    id: string;
    state: string;
    model?: string;
}
export declare class AdbClient {
    private deviceId?;
    constructor(deviceId?: string);
    private get deviceFlag();
    /**
     * Execute ADB command and return stdout as string
     */
    exec(command: string): string;
    /**
     * Execute ADB command and return raw bytes (for screenshots)
     */
    execRaw(command: string): Buffer;
    /**
     * Execute ADB command async (non-blocking)
     */
    execAsync(command: string): Promise<string>;
    /**
     * Execute ADB command async and return raw bytes (for screenshots)
     */
    execRawAsync(command: string): Promise<Buffer>;
    /**
     * Get list of connected devices
     */
    getDevices(): Device[];
    /**
     * Set active device
     */
    setDevice(deviceId: string): void;
    /**
     * Take screenshot and return raw PNG buffer
     */
    screenshotRaw(): Buffer;
    /**
     * Take screenshot async (non-blocking)
     */
    screenshotRawAsync(): Promise<Buffer>;
    /**
     * Take screenshot and return as base64 PNG (legacy)
     */
    screenshot(): string;
    /**
     * Tap at coordinates
     */
    tap(x: number, y: number): void;
    /**
     * Long press at coordinates
     */
    longPress(x: number, y: number, durationMs?: number): void;
    /**
     * Swipe gesture
     */
    swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): void;
    /**
     * Swipe in direction (uses screen center)
     */
    swipeDirection(direction: "up" | "down" | "left" | "right", distance?: number): void;
    /**
     * Input text
     */
    inputText(text: string): void;
    /**
     * Press key by name or keycode
     */
    pressKey(key: string): void;
    /**
     * Get UI hierarchy XML (sync — blocks event loop)
     */
    getUiHierarchy(): string;
    /**
     * Get UI hierarchy XML async (non-blocking)
     */
    getUiHierarchyAsync(): Promise<string>;
    /**
     * Launch app by package name
     */
    launchApp(packageName: string): string;
    /**
     * Stop app
     */
    stopApp(packageName: string): void;
    /**
     * Clear app data
     */
    clearAppData(packageName: string): void;
    /**
     * Grant runtime permission to app
     */
    grantPermission(packageName: string, permission: string): void;
    /**
     * Revoke runtime permission from app
     */
    revokePermission(packageName: string, permission: string): void;
    /**
     * Reset all permissions for app (clears app data)
     */
    resetPermissions(packageName: string): void;
    /**
     * Install APK
     */
    installApk(apkPath: string): string;
    /**
     * Uninstall app
     */
    uninstallApp(packageName: string): string;
    /**
     * Get current activity
     */
    getCurrentActivity(): string;
    /**
     * Get screen size
     */
    getScreenSize(): {
        width: number;
        height: number;
    };
    /**
     * Wait for device
     */
    waitForDevice(): void;
    /**
     * Execute shell command
     */
    shell(command: string): string;
    /**
     * Get device logs (logcat)
     * @param options - filter options
     */
    getLogs(options?: {
        tag?: string;
        level?: "V" | "D" | "I" | "W" | "E" | "F";
        lines?: number;
        since?: string;
        package?: string;
    }): string;
    /**
     * Clear logcat buffer
     */
    clearLogs(): void;
    /**
     * Get network stats
     */
    getNetworkStats(): string;
    /**
     * Get battery info
     */
    getBatteryInfo(): string;
    /**
     * Get memory info
     */
    getMemoryInfo(packageName?: string): string;
    /**
     * Get CPU info
     */
    getCpuInfo(): string;
}
//# sourceMappingURL=client.d.ts.map