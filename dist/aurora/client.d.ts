export interface ScreenshotOptions {
    compress?: boolean;
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
}
export interface ScreenshotResult {
    data: string;
    mimeType: string;
}
export interface Device {
    id: string;
    name: string;
    platform: "aurora";
    state: string;
    isSimulator: boolean;
    host?: string;
}
export interface LogOptions {
    lines?: number;
    priority?: string;
    unit?: string;
    grep?: string;
    since?: string;
}
export declare class AuroraClient {
    private runCommand;
    checkAvailability(): Promise<boolean>;
    /**
     * List all configured Aurora devices
     * @returns Array of Device objects
     */
    listDevices(): Promise<Device[]>;
    getActiveDevice(): Promise<string>;
    /**
     * Performs a tap at the specified coordinates.
     * @param x - X coordinate in pixels
     * @param y - Y coordinate in pixels
     */
    tap(x: number, y: number): Promise<void>;
    /**
     * Performs a long press at the specified coordinates.
     * @param x - X coordinate in pixels
     * @param y - Y coordinate in pixels
     * @param duration - Duration of the press in milliseconds
     */
    longPress(x: number, y: number, duration: number): Promise<void>;
    /**
     * Performs a swipe in the specified direction.
     * @param direction - Direction to swipe: "up", "down", "left", or "right"
     */
    swipeDirection(direction: "up" | "down" | "left" | "right"): Promise<void>;
    /**
     * Performs a swipe from one coordinate to another.
     * @param x1 - Starting X coordinate in pixels
     * @param y1 - Starting Y coordinate in pixels
     * @param x2 - Ending X coordinate in pixels
     * @param y2 - Ending Y coordinate in pixels
     */
    swipeCoords(x1: number, y1: number, x2: number, y2: number): Promise<void>;
    /**
     * Sends a keyboard key event to the device.
     * @param key - Key name to send (e.g., "Enter", "Back", "Home")
     */
    pressKey(key: string): Promise<void>;
    /**
     * Takes a screenshot of the Aurora device
     * @param options - Screenshot options (compression, size, quality)
     * @returns Screenshot result with base64 data and MIME type
     */
    screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;
    /**
     * Launch an application on the Aurora device
     * @param packageName - Application name (D-Bus format: ru.domain.AppName)
     * @returns Output message from audb
     */
    launchApp(packageName: string): Promise<string>;
    /**
     * Stop a running application
     * @param packageName - Application name (D-Bus format: ru.domain.AppName)
     * @returns Promise that resolves when the app is stopped
     */
    stopApp(packageName: string): Promise<void>;
    /**
     * Install an RPM package on the Aurora device
     * @param path - Local path to the RPM file
     * @returns Installation result message
     */
    installApp(path: string): Promise<string>;
    /**
     * Uninstall a package from the Aurora device
     * @param packageName - Package name (e.g., ru.domain.AppName)
     * @returns Uninstallation result message
     */
    uninstallApp(packageName: string): Promise<string>;
    /**
     * List installed packages on the Aurora device
     * @returns Array of package names
     */
    listPackages(): Promise<string[]>;
    /**
     * Execute a shell command on the Aurora device
     *
     * WARNING: This method executes arbitrary commands on the device.
     * Input validation should be performed at the call site.
     *
     * @param command - Shell command to execute (must be validated/sanitized)
     * @returns Command output
     */
    shell(command: string): Promise<string>;
    /**
     * Get device logs with optional filters
     * @param options - Log filtering options
     * @param options.lines - Maximum number of log lines to retrieve
     * @param options.priority - Filter by log priority level
     * @param options.unit - Filter by systemd unit
     * @param options.grep - Filter by grep pattern
     * @param options.since - Show logs since timestamp
     * @returns Log output
     */
    getLogs(options?: LogOptions): Promise<string>;
    /**
     * Clear device logs
     * @returns Result message
     */
    clearLogs(): Promise<string>;
    /**
     * Get detailed system information
     * @returns System info output
     */
    getSystemInfo(): Promise<string>;
    /**
     * Upload a file to the Aurora device
     * @param localPath - Path to the local file
     * @param remotePath - Destination path on the device
     * @returns Upload result message
     */
    pushFile(localPath: string, remotePath: string): Promise<string>;
    /**
     * Download a file from the Aurora device
     * @param remotePath - Path to the remote file
     * @param localPath - Optional local destination path (defaults to remote filename)
     * @returns File contents as Buffer
     */
    pullFile(remotePath: string, localPath?: string): Promise<Buffer>;
}
export declare const auroraClient: AuroraClient;
//# sourceMappingURL=client.d.ts.map