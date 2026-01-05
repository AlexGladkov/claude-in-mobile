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
     * Execute ADB command async
     */
    execAsync(command: string): Promise<string>;
    /**
     * Get list of connected devices
     */
    getDevices(): Device[];
    /**
     * Set active device
     */
    setDevice(deviceId: string): void;
    /**
     * Take screenshot and return as base64
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
     * Get UI hierarchy XML
     */
    getUiHierarchy(): string;
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
}
//# sourceMappingURL=client.d.ts.map