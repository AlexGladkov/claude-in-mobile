import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WDAClient } from "./wda-client.js";
export class WDAManager {
    instances = new Map();
    clients = new Map();
    /** Deduplicates parallel launches for the same device */
    launchPromises = new Map();
    startupTimeout = 30000;
    buildTimeout = 120000;
    async ensureWDAReady(deviceId) {
        // Check existing client
        if (this.clients.has(deviceId)) {
            const client = this.clients.get(deviceId);
            try {
                await client.ensureSession(deviceId);
                return client;
            }
            catch (error) {
                console.error("WDA client failed, relaunching:", error.message);
                // Clean up failed instance
                const instance = this.instances.get(deviceId);
                if (instance) {
                    try {
                        process.kill(instance.pid);
                    }
                    catch { }
                }
                this.clients.delete(deviceId);
                this.instances.delete(deviceId);
                // Fall through to relaunch
            }
        }
        // Deduplicate parallel launches — if another call is already launching
        // WDA for this device, reuse its promise instead of spawning a second xcodebuild
        if (this.launchPromises.has(deviceId)) {
            return this.launchPromises.get(deviceId);
        }
        const launchPromise = this.doLaunch(deviceId);
        this.launchPromises.set(deviceId, launchPromise);
        try {
            return await launchPromise;
        }
        finally {
            this.launchPromises.delete(deviceId);
        }
    }
    async doLaunch(deviceId) {
        const wdaPath = await this.discoverWDA();
        await this.buildWDAIfNeeded(wdaPath);
        const port = await this.findFreePort();
        await this.launchWDA(wdaPath, deviceId, port);
        const client = new WDAClient(port);
        await client.ensureSession(deviceId);
        this.clients.set(deviceId, client);
        return client;
    }
    async discoverWDA() {
        const searchPaths = [
            process.env.WDA_PATH,
            path.join(os.homedir(), ".appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent"),
            "/opt/homebrew/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent",
            "/usr/local/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent",
        ].filter(Boolean);
        for (const searchPath of searchPaths) {
            if (fs.existsSync(searchPath)) {
                const projectPath = path.join(searchPath, "WebDriverAgent.xcodeproj");
                if (fs.existsSync(projectPath)) {
                    return searchPath;
                }
            }
        }
        throw new Error("WebDriverAgent not found.\n\n" +
            "Install Appium with XCUITest driver:\n" +
            "  npm install -g appium\n" +
            "  appium driver install xcuitest\n\n" +
            "Or set WDA_PATH environment variable:\n" +
            "  export WDA_PATH=/path/to/WebDriverAgent\n\n" +
            "Search paths checked:\n" +
            searchPaths.map((p) => `  - ${p}`).join("\n"));
    }
    async buildWDAIfNeeded(wdaPath) {
        const buildDir = path.join(wdaPath, "build");
        if (fs.existsSync(buildDir)) {
            return;
        }
        console.error("Building WebDriverAgent for first use...");
        try {
            execSync("xcodebuild build-for-testing " +
                "-project WebDriverAgent.xcodeproj " +
                "-scheme WebDriverAgentRunner " +
                "-destination 'platform=iOS Simulator,name=iPhone 14'", {
                cwd: wdaPath,
                timeout: this.buildTimeout,
                stdio: "pipe",
            });
        }
        catch (error) {
            throw new Error("Failed to build WebDriverAgent.\n\n" +
                `${error.stderr?.toString() || error.stdout?.toString() || error.message}\n\n` +
                "Troubleshooting:\n" +
                "1. Install Xcode: https://apps.apple.com/app/xcode/id497799835\n" +
                "2. Install command line tools: xcode-select --install\n" +
                "3. Accept license: sudo xcodebuild -license accept\n" +
                "4. Set Xcode path: sudo xcode-select -s /Applications/Xcode.app");
        }
    }
    async launchWDA(wdaPath, deviceId, port) {
        const existingInstance = this.instances.get(deviceId);
        if (existingInstance) {
            try {
                process.kill(existingInstance.pid, 0);
                return;
            }
            catch {
                this.instances.delete(deviceId);
            }
        }
        const wdaProcess = spawn("xcodebuild", [
            "test-without-building",
            "-project",
            "WebDriverAgent.xcodeproj",
            "-scheme",
            "WebDriverAgentRunner",
            "-destination",
            `platform=iOS Simulator,id=${deviceId}`,
        ], {
            cwd: wdaPath,
            env: {
                ...process.env,
                USE_PORT: port.toString(),
            },
            stdio: "pipe",
        });
        this.instances.set(deviceId, {
            pid: wdaProcess.pid,
            port,
            deviceId,
        });
        let output = "";
        wdaProcess.stdout?.on("data", (data) => {
            output += data.toString();
        });
        wdaProcess.stderr?.on("data", (data) => {
            output += data.toString();
        });
        wdaProcess.on("exit", (code) => {
            this.instances.delete(deviceId);
            this.clients.delete(deviceId);
        });
        const startTime = Date.now();
        while (Date.now() - startTime < this.startupTimeout) {
            try {
                const health = await this.checkHealth(port);
                if (health) {
                    return;
                }
            }
            catch {
                // Continue waiting
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        try {
            process.kill(wdaProcess.pid);
        }
        catch { }
        throw new Error("WebDriverAgent failed to start within 30s.\n\n" +
            "Troubleshooting:\n" +
            "1. Check simulator is running: xcrun simctl list | grep Booted\n" +
            "2. Check logs: ~/Library/Logs/CoreSimulator/" +
            deviceId +
            "/system.log\n" +
            "3. Try manual launch to see errors:\n" +
            `   cd ${wdaPath}\n` +
            "   xcodebuild test -project WebDriverAgent.xcodeproj \\\n" +
            "     -scheme WebDriverAgentRunner \\\n" +
            `     -destination 'platform=iOS Simulator,id=${deviceId}'\n\n` +
            `Last output:\n${output.slice(-500)}`);
    }
    async checkHealth(port) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);
            const response = await fetch(`http://localhost:${port}/status`, {
                signal: controller.signal,
            });
            clearTimeout(timeout);
            return response.ok;
        }
        catch {
            return false;
        }
    }
    async findFreePort() {
        const { createServer } = await import("net");
        for (let port = 8100; port < 8200; port++) {
            try {
                await new Promise((resolve, reject) => {
                    const server = createServer();
                    server.once("error", reject);
                    server.once("listening", () => {
                        server.close(() => resolve());
                    });
                    server.listen(port);
                });
                return port;
            }
            catch {
                continue;
            }
        }
        throw new Error("No free ports available in range 8100-8200");
    }
    cleanup() {
        for (const [deviceId, instance] of this.instances) {
            try {
                process.kill(instance.pid);
            }
            catch { }
            const client = this.clients.get(deviceId);
            if (client) {
                client.deleteSession().catch(() => { });
            }
        }
        this.instances.clear();
        this.clients.clear();
    }
}
//# sourceMappingURL=wda-manager.js.map