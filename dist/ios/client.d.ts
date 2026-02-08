import { WDAElement, WDARect } from "./wda/index.js";
export interface IosDevice {
    id: string;
    name: string;
    state: string;
    runtime: string;
    isSimulator: boolean;
}
export declare class IosClient {
    private deviceId?;
    private wdaManager;
    private wdaClient?;
    constructor(deviceId?: string);
    private ensureWDA;
    /**
     * Execute simctl command
     */
    private exec;
    /**
     * Get the active device ID or 'booted'
     */
    private get targetDevice();
    /**
     * Get list of iOS simulators
     */
    getDevices(): IosDevice[];
    /**
     * Get booted simulators
     */
    getBootedDevices(): IosDevice[];
    /**
     * Set active device
     */
    setDevice(deviceId: string): void;
    /**
     * Boot simulator
     */
    boot(deviceId?: string): void;
    /**
     * Shutdown simulator
     */
    shutdown(deviceId?: string): void;
    /**
     * Take screenshot and return raw PNG buffer
     */
    screenshotRaw(): Buffer;
    /**
     * Take screenshot and return as base64 (legacy)
     */
    screenshot(): string;
    /**
     * Tap at coordinates
     */
    tap(x: number, y: number): Promise<void>;
    /**
     * Swipe gesture
     */
    swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void>;
    /**
     * Swipe in direction
     */
    swipeDirection(direction: "up" | "down" | "left" | "right", distance?: number): Promise<void>;
    /**
     * Input text using simctl
     */
    inputText(text: string): void;
    /**
     * Press key
     */
    pressKey(key: string): void;
    /**
     * Launch app by bundle ID
     */
    launchApp(bundleId: string): string;
    /**
     * Terminate app
     */
    stopApp(bundleId: string): void;
    /**
     * Install app (.app bundle or .ipa)
     */
    installApp(path: string): string;
    /**
     * Uninstall app
     */
    uninstallApp(bundleId: string): string;
    /**
     * Get UI hierarchy (limited on iOS simulator)
     * Returns accessibility info if available
     */
    getUiHierarchy(): Promise<string>;
    /**
     * Find element by text or label
     */
    findElement(criteria: {
        text?: string;
        label?: string;
    }): Promise<WDAElement>;
    /**
     * Find multiple elements by criteria
     */
    findElements(criteria: {
        text?: string;
        label?: string;
        type?: string;
        visible?: boolean;
    }): Promise<Array<{
        id: string;
        type: string;
        label: string;
        rect: WDARect;
    }>>;
    /**
     * Tap element by element ID
     */
    tapElement(elementId: string): Promise<void>;
    /**
     * Open URL in simulator
     */
    openUrl(url: string): void;
    /**
     * Add photo to simulator
     */
    addPhoto(imagePath: string): void;
    /**
     * Set location
     */
    setLocation(lat: number, lon: number): void;
    /**
     * Get device info
     */
    getDeviceInfo(): Record<string, string>;
    /**
     * Execute arbitrary simctl command
     */
    shell(command: string): string;
    /**
     * Get device logs
     */
    getLogs(options?: {
        predicate?: string;
        lines?: number;
        level?: "debug" | "info" | "default" | "error" | "fault";
    }): string;
    /**
     * Get app-specific logs
     */
    getAppLogs(bundleId: string, lines?: number): string;
    /**
     * Clear logs (not fully supported on iOS, but we can note the timestamp)
     */
    clearLogs(): string;
    /**
     * Grant privacy permission on iOS simulator
     * Services: camera, microphone, photos, location, contacts, calendar, reminders, motion, health, speech-recognition
     */
    grantPermission(bundleId: string, service: string): string;
    /**
     * Revoke privacy permission on iOS simulator
     */
    revokePermission(bundleId: string, service: string): string;
    /**
     * Reset all privacy permissions for an app on iOS simulator
     */
    resetPermissions(bundleId: string): string;
}
//# sourceMappingURL=client.d.ts.map