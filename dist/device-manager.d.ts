import { AdbClient } from "./adb/client.js";
import { IosClient } from "./ios/client.js";
import { DesktopClient } from "./desktop/client.js";
import { type CompressOptions } from "./utils/image.js";
import type { LaunchOptions } from "./desktop/types.js";
import { AuroraClient } from "./aurora/index.js";
export type Platform = "android" | "ios" | "desktop" | "aurora";
export interface Device {
    id: string;
    name: string;
    platform: Platform;
    state: string;
    isSimulator: boolean;
}
export declare class DeviceManager {
    private androidClient;
    private iosClient;
    private desktopClient;
    private auroraClient;
    private activeDevice?;
    private activeTarget;
    constructor();
    private getClient;
    /**
     * Set active target platform
     */
    setTarget(target: Platform): void;
    /**
     * Get active target and its status
     */
    getTarget(): {
        target: Platform;
        status: string;
    };
    /**
     * Launch desktop automation (and optionally a user's app via Gradle)
     */
    launchDesktopApp(options: LaunchOptions): Promise<string>;
    /**
     * Stop desktop app
     */
    stopDesktopApp(): Promise<void>;
    /**
     * Get desktop client directly
     */
    getDesktopClient(): DesktopClient;
    /**
     * Check if desktop app is running
     */
    isDesktopRunning(): boolean;
    /**
     * Get all connected devices (Android + iOS + Aurora)
     */
    getAllDevices(): Device[];
    /**
     * Get devices filtered by platform
     */
    getDevices(platform?: Platform): Device[];
    /**
     * Set active device
     */
    setDevice(deviceId: string, platform?: Platform): Device;
    /**
     * Get active device
     */
    getActiveDevice(): Device | undefined;
    /**
     * Get current platform
     */
    getCurrentPlatform(): Platform;
    /**
     * Take screenshot with optional compression
     */
    screenshot(platform?: Platform, compress?: boolean, options?: CompressOptions & {
        monitorIndex?: number;
    }): Promise<{
        data: string;
        mimeType: string;
    }>;
    /**
     * Take screenshot without compression (legacy)
     */
    screenshotRaw(platform?: Platform): string;
    /**
     * Tap at coordinates
     * @param targetPid - Optional PID for desktop background mode (no focus stealing)
     */
    tap(x: number, y: number, platform?: Platform, targetPid?: number): Promise<void>;
    /**
     * Long press
     */
    longPress(x: number, y: number, durationMs?: number, platform?: Platform): Promise<void>;
    /**
     * Swipe
     */
    swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number, platform?: Platform): Promise<void>;
    /**
     * Swipe direction
     */
    swipeDirection(direction: "up" | "down" | "left" | "right", platform?: Platform): Promise<void>;
    /**
     * Input text
     * @param targetPid - Optional PID for desktop background mode (no focus stealing)
     */
    inputText(text: string, platform?: Platform, targetPid?: number): Promise<void>;
    /**
     * Press key
     * @param targetPid - Optional PID for desktop background mode (no focus stealing)
     */
    pressKey(key: string, platform?: Platform, targetPid?: number): Promise<void>;
    /**
     * Launch app
     */
    launchApp(packageOrBundleId: string, platform?: Platform): string;
    /**
     * Stop app
     */
    stopApp(packageOrBundleId: string, platform?: Platform): void;
    /**
     * Install app
     */
    installApp(path: string, platform?: Platform): string;
    /**
     * Get UI hierarchy
     */
    getUiHierarchy(platform?: Platform): Promise<string>;
    /**
     * Execute shell command
     */
    shell(command: string, platform?: Platform): string;
    /**
     * Get Android client directly
     */
    getAndroidClient(): AdbClient;
    /**
     * Get iOS client directly
     */
    getIosClient(): IosClient;
    /**
     * Get Aurora client directly
     */
    getAuroraClient(): AuroraClient;
    /**
     * Get device logs
     */
    getLogs(options?: {
        platform?: Platform;
        level?: string;
        tag?: string;
        lines?: number;
        package?: string;
    }): string;
    /**
     * Clear logs
     */
    clearLogs(platform?: Platform): string;
    /**
     * Get system info (battery, memory, etc.)
     */
    getSystemInfo(platform?: Platform): Promise<string>;
}
//# sourceMappingURL=device-manager.d.ts.map