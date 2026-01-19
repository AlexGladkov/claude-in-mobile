/**
 * Desktop Client - communicates with Kotlin companion app via JSON-RPC
 */
import { spawn, execSync } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { GradleLauncher } from "./gradle.js";
const MAX_RESTARTS = 3;
const REQUEST_TIMEOUT = 30000; // 30 seconds
// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * Find the companion app path
 */
function findCompanionAppPath() {
    // Look for companion app relative to this module
    // The installed distribution is at desktop-companion/build/install/desktop-companion/bin/desktop-companion
    const possiblePaths = [
        // From dist/desktop/client.js
        path.join(__dirname, "..", "..", "desktop-companion", "build", "install", "desktop-companion", "bin", "desktop-companion"),
        // From src/desktop/client.ts (when running directly)
        path.join(__dirname, "..", "..", "..", "desktop-companion", "build", "install", "desktop-companion", "bin", "desktop-companion"),
    ];
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    throw new Error("Desktop companion app not found. Please build it first: cd desktop-companion && ./gradlew installDist");
}
export class DesktopClient extends EventEmitter {
    process = null;
    gradleLauncher;
    requestId = 0;
    pendingRequests = new Map();
    logs = [];
    maxLogs = 10000;
    state = {
        status: "stopped",
        crashCount: 0,
    };
    lastLaunchOptions = null;
    readline = null;
    constructor() {
        super();
        this.gradleLauncher = new GradleLauncher();
    }
    /**
     * Get current state
     */
    getState() {
        return { ...this.state };
    }
    /**
     * Check if running
     */
    isRunning() {
        return this.state.status === "running" && this.process !== null && !this.process.killed;
    }
    /**
     * Launch desktop automation (starts companion app, optionally launches user's app via Gradle)
     */
    async launch(options) {
        if (this.isRunning()) {
            throw new Error("Desktop companion is already running. Stop it first.");
        }
        this.lastLaunchOptions = options;
        this.state = {
            status: "starting",
            projectPath: options.projectPath,
            crashCount: this.state.crashCount,
        };
        try {
            // Find and start the companion app
            const companionPath = findCompanionAppPath();
            this.addLog("stdout", `Starting companion app: ${companionPath}`);
            this.process = spawn(companionPath, [], {
                stdio: ["pipe", "pipe", "pipe"],
                env: {
                    ...process.env,
                    JAVA_HOME: process.env.JAVA_HOME || execSync("/usr/libexec/java_home -v 21 2>/dev/null || /usr/libexec/java_home 2>/dev/null || echo ''").toString().trim(),
                },
            });
            this.state.pid = this.process.pid;
            // If projectPath is provided, also launch the user's app via Gradle (in background)
            if (options.projectPath) {
                this.addLog("stdout", `Launching user app from: ${options.projectPath}`);
                // Launch in background - don't wait for it
                const userAppProcess = this.gradleLauncher.launch(options);
                userAppProcess.stdout?.on("data", (data) => {
                    this.addLog("stdout", `[UserApp] ${data.toString()}`);
                });
                userAppProcess.stderr?.on("data", (data) => {
                    this.addLog("stderr", `[UserApp] ${data.toString()}`);
                });
            }
            // Set up stdout for JSON-RPC responses
            if (this.process.stdout) {
                this.readline = readline.createInterface({
                    input: this.process.stdout,
                    crlfDelay: Infinity,
                });
                this.readline.on("line", (line) => {
                    this.handleLine(line);
                });
            }
            // Capture stderr for logs
            if (this.process.stderr) {
                this.process.stderr.on("data", (data) => {
                    const message = data.toString();
                    this.addLog("stderr", message);
                    // Check for "ready" signal or specific patterns
                    if (message.includes("Desktop companion ready") ||
                        message.includes("JsonRpcServer started")) {
                        this.state.status = "running";
                        this.emit("ready");
                    }
                });
            }
            // Handle process exit
            this.process.on("exit", (code, signal) => {
                this.handleExit(code, signal);
            });
            this.process.on("error", (error) => {
                this.addLog("crash", `Process error: ${error.message}`);
                this.handleCrash(error);
            });
            // Wait for ready signal or timeout
            await this.waitForReady(10000);
        }
        catch (error) {
            this.state.status = "stopped";
            this.state.lastError = error.message;
            throw error;
        }
    }
    /**
     * Wait for the companion app to be ready
     */
    waitForReady(timeoutMs) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                // Consider ready even without explicit signal after timeout
                // The app might not send a ready signal
                if (this.process && !this.process.killed) {
                    this.state.status = "running";
                    resolve();
                }
                else {
                    reject(new Error("Desktop app failed to start"));
                }
            }, timeoutMs);
            this.once("ready", () => {
                clearTimeout(timeout);
                resolve();
            });
            this.process?.once("exit", () => {
                clearTimeout(timeout);
                reject(new Error("Desktop app exited before becoming ready"));
            });
        });
    }
    /**
     * Stop desktop app
     */
    async stop() {
        if (!this.process) {
            return;
        }
        // Clean up readline
        if (this.readline) {
            this.readline.close();
            this.readline = null;
        }
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("Desktop app stopped"));
        }
        this.pendingRequests.clear();
        // Stop process
        this.gradleLauncher.stop(this.process);
        this.process = null;
        this.state = {
            status: "stopped",
            crashCount: 0,
        };
    }
    /**
     * Handle incoming line from stdout
     */
    handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed)
            return;
        // Try to parse as JSON-RPC response
        if (trimmed.startsWith("{")) {
            try {
                const response = JSON.parse(trimmed);
                this.handleResponse(response);
                return;
            }
            catch {
                // Not JSON, treat as log
            }
        }
        // Regular log output
        this.addLog("stdout", trimmed);
    }
    /**
     * Handle JSON-RPC response
     */
    handleResponse(response) {
        const pending = this.pendingRequests.get(response.id);
        if (!pending) {
            return; // Unknown response
        }
        this.pendingRequests.delete(response.id);
        clearTimeout(pending.timeout);
        if (response.error) {
            pending.reject(new Error(`${response.error.message} (code: ${response.error.code})`));
        }
        else {
            pending.resolve(response.result);
        }
    }
    /**
     * Handle process exit
     */
    handleExit(code, signal) {
        const wasRunning = this.state.status === "running";
        if (code !== 0 && wasRunning) {
            this.addLog("crash", `Process exited with code ${code}, signal ${signal}`);
            this.handleCrash(new Error(`Exit code: ${code}`));
        }
        else {
            this.state.status = "stopped";
        }
        this.process = null;
    }
    /**
     * Handle crash with auto-restart
     */
    async handleCrash(error) {
        this.state.status = "crashed";
        this.state.crashCount++;
        this.state.lastError = error.message;
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("Desktop app crashed"));
        }
        this.pendingRequests.clear();
        // Auto-restart if under limit
        if (this.state.crashCount <= MAX_RESTARTS && this.lastLaunchOptions) {
            console.error(`Desktop app crashed, restarting (${this.state.crashCount}/${MAX_RESTARTS})...`);
            try {
                await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait before restart
                await this.launch(this.lastLaunchOptions);
            }
            catch (restartError) {
                console.error(`Failed to restart: ${restartError.message}`);
            }
        }
        else {
            this.emit("crash", error);
        }
    }
    /**
     * Send JSON-RPC request
     */
    async sendRequest(method, params) {
        if (!this.isRunning() || !this.process?.stdin) {
            throw new Error("Desktop app is not running");
        }
        const id = ++this.requestId;
        const request = {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request timeout: ${method}`));
            }, REQUEST_TIMEOUT);
            this.pendingRequests.set(id, {
                resolve: resolve,
                reject,
                timeout,
            });
            const json = JSON.stringify(request);
            this.process.stdin.write(json + "\n");
        });
    }
    /**
     * Add log entry
     */
    addLog(type, message) {
        this.logs.push({
            timestamp: Date.now(),
            type,
            message,
        });
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }
    }
    // ============ Public API Methods ============
    /**
     * Take screenshot
     */
    async screenshotRaw(options) {
        const result = await this.sendRequest("screenshot", options);
        return Buffer.from(result.base64, "base64");
    }
    /**
     * Take screenshot and return base64
     */
    async screenshot(options) {
        const result = await this.sendRequest("screenshot", options);
        return result.base64;
    }
    /**
     * Get screenshot with metadata
     */
    async screenshotWithMeta(options) {
        return this.sendRequest("screenshot", options);
    }
    /**
     * Tap at coordinates
     */
    async tap(x, y) {
        await this.sendRequest("tap", { x, y });
    }
    /**
     * Long press at coordinates
     */
    async longPress(x, y, durationMs = 1000) {
        await this.sendRequest("long_press", { x, y, durationMs });
    }
    /**
     * Swipe gesture
     */
    async swipe(x1, y1, x2, y2, durationMs = 300) {
        await this.sendRequest("swipe", { x1, y1, x2, y2, durationMs });
    }
    /**
     * Swipe in direction
     */
    async swipeDirection(direction, distance) {
        await this.sendRequest("swipe_direction", { direction, distance });
    }
    /**
     * Input text
     */
    async inputText(text) {
        await this.sendRequest("input_text", { text });
    }
    /**
     * Press key
     */
    async pressKey(key, modifiers) {
        await this.sendRequest("key_event", { key, modifiers });
    }
    /**
     * Get UI hierarchy
     */
    async getUiHierarchy(windowId) {
        return this.sendRequest("get_ui_hierarchy", { windowId });
    }
    /**
     * Get UI hierarchy as XML string (for compatibility)
     */
    getUiHierarchyXml() {
        // Not supported - desktop uses accessibility tree
        throw new Error("XML hierarchy not supported for desktop. Use getUiHierarchy() instead.");
    }
    /**
     * Get window information
     */
    async getWindowInfo() {
        return this.sendRequest("get_window_info");
    }
    /**
     * Focus a window
     */
    async focusWindow(windowId) {
        await this.sendRequest("focus_window", { windowId });
    }
    /**
     * Resize a window
     */
    async resizeWindow(width, height, windowId) {
        await this.sendRequest("resize_window", { windowId, width, height });
    }
    /**
     * Get clipboard content
     */
    async getClipboard() {
        const result = await this.sendRequest("get_clipboard");
        return result.text ?? "";
    }
    /**
     * Set clipboard content
     */
    async setClipboard(text) {
        await this.sendRequest("set_clipboard", { text });
    }
    /**
     * Check accessibility permissions
     */
    async checkPermissions() {
        return this.sendRequest("check_permissions");
    }
    /**
     * Get logs
     */
    getLogs(options) {
        let result = [...this.logs];
        if (options?.type) {
            result = result.filter((log) => log.type === options.type);
        }
        if (options?.since) {
            result = result.filter((log) => log.timestamp >= options.since);
        }
        if (options?.limit) {
            result = result.slice(-options.limit);
        }
        return result;
    }
    /**
     * Clear logs
     */
    clearLogs() {
        this.logs = [];
    }
    /**
     * Get performance metrics
     */
    async getPerformanceMetrics() {
        return this.sendRequest("get_performance_metrics");
    }
    /**
     * Get screen size
     */
    async getScreenSize() {
        const info = await this.getWindowInfo();
        if (info.windows.length > 0) {
            const focused = info.windows.find((w) => w.focused) ?? info.windows[0];
            return {
                width: focused.bounds.width,
                height: focused.bounds.height,
            };
        }
        return { width: 1920, height: 1080 }; // Default
    }
    /**
     * Get list of connected monitors (multi-monitor support)
     */
    async getMonitors() {
        const result = await this.sendRequest("get_monitors");
        return result.monitors;
    }
    /**
     * Launch app (for compatibility with mobile interface)
     */
    launchApp(packageName) {
        // Desktop doesn't have package-based launch
        return `Desktop platform doesn't support package launch. Use launch_desktop_app to start a Compose Desktop project.`;
    }
    /**
     * Stop app (for compatibility)
     */
    stopApp(packageName) {
        // No-op for desktop
    }
    /**
     * Shell command (not supported)
     */
    shell(command) {
        throw new Error("Shell commands not supported for desktop. Use native APIs.");
    }
}
// Export singleton instance
export const desktopClient = new DesktopClient();
//# sourceMappingURL=client.js.map