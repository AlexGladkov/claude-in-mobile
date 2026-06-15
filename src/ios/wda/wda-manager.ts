import { execSync, spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { WDAClient } from "./wda-client.js";
import { WDAInstanceInfo } from "./wda-types.js";

/** Port WDA listens on inside a physical device; the local end is forwarded. */
const DEVICE_WDA_PORT = 8100;
/** go-ios binary (overridable, mirrors src/ios/go-ios/client.ts). */
const GO_IOS_BIN = process.env.GO_IOS_BIN ?? "ios";

export class WDAManager {
  private instances: Map<string, WDAInstanceInfo> = new Map();
  private clients: Map<string, WDAClient> = new Map();
  /** Deduplicates parallel launches for the same device */
  private launchPromises: Map<string, Promise<WDAClient>> = new Map();
  /** Long-lived `ios forward` processes for physical devices, by udid. */
  private forwards: Map<string, ChildProcess> = new Map();
  private readonly startupTimeout = 30000;
  /** Physical first-run does a full device build+sign+install — much slower. */
  private readonly deviceStartupTimeout = 300000;
  private readonly buildTimeout = 120000;

  async ensureWDAReady(
    deviceId: string,
    isSimulator: boolean = true
  ): Promise<WDAClient> {
    // Check existing client
    if (this.clients.has(deviceId)) {
      const client = this.clients.get(deviceId)!;
      try {
        await client.ensureSession(deviceId);
        return client;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("WDA client failed, relaunching:", msg);
        // Clean up failed instance
        const instance = this.instances.get(deviceId);
        if (instance) {
          try {
            process.kill(instance.pid);
          } catch {}
        }
        this.clients.delete(deviceId);
        this.instances.delete(deviceId);
        // Fall through to relaunch
      }
    }

    // Deduplicate parallel launches — if another call is already launching
    // WDA for this device, reuse its promise instead of spawning a second xcodebuild
    if (this.launchPromises.has(deviceId)) {
      return this.launchPromises.get(deviceId)!;
    }

    const launchPromise = this.doLaunch(deviceId, isSimulator);
    this.launchPromises.set(deviceId, launchPromise);

    try {
      return await launchPromise;
    } finally {
      this.launchPromises.delete(deviceId);
    }
  }

  private async doLaunch(
    deviceId: string,
    isSimulator: boolean
  ): Promise<WDAClient> {
    const wdaPath = await this.discoverWDA();
    const port = await this.findFreePort();

    if (isSimulator) {
      await this.buildWDAIfNeeded(wdaPath);
      await this.launchWDA(wdaPath, deviceId, port);
    } else {
      await this.launchWDADevice(wdaPath, deviceId, port);
    }

    const client = new WDAClient(port);
    await client.ensureSession(deviceId);

    this.clients.set(deviceId, client);

    return client;
  }

  private async discoverWDA(): Promise<string> {
    const searchPaths = [
      process.env.WDA_PATH,
      path.join(
        os.homedir(),
        ".appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent"
      ),
      "/opt/homebrew/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent",
      "/usr/local/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent",
    ].filter(Boolean) as string[];

    for (const searchPath of searchPaths) {
      if (fs.existsSync(searchPath)) {
        const projectPath = path.join(searchPath, "WebDriverAgent.xcodeproj");
        if (fs.existsSync(projectPath)) {
          return searchPath;
        }
      }
    }

    throw new Error(
      "WebDriverAgent not found.\n\n" +
        "Install Appium with XCUITest driver:\n" +
        "  npm install -g appium\n" +
        "  appium driver install xcuitest\n\n" +
        "Or set WDA_PATH environment variable:\n" +
        "  export WDA_PATH=/path/to/WebDriverAgent\n\n" +
        "Search paths checked:\n" +
        searchPaths.map((p) => `  - ${p}`).join("\n")
    );
  }

  private async buildWDAIfNeeded(wdaPath: string): Promise<void> {
    const buildDir = path.join(wdaPath, "build");
    if (fs.existsSync(buildDir)) {
      return;
    }

    console.error("Building WebDriverAgent for first use...");

    try {
      execSync(
        "xcodebuild build-for-testing " +
          "-project WebDriverAgent.xcodeproj " +
          "-scheme WebDriverAgentRunner " +
          "-destination 'platform=iOS Simulator,name=iPhone 14'",
        {
          cwd: wdaPath,
          timeout: this.buildTimeout,
          stdio: "pipe",
        }
      );
    } catch (error: unknown) {
      const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
      const detail = e.stderr?.toString() || e.stdout?.toString() || e.message || String(error);
      throw new Error(
        "Failed to build WebDriverAgent.\n\n" +
          `${detail}\n\n` +
          "Troubleshooting:\n" +
          "1. Install Xcode: https://apps.apple.com/app/xcode/id497799835\n" +
          "2. Install command line tools: xcode-select --install\n" +
          "3. Accept license: sudo xcodebuild -license accept\n" +
          "4. Set Xcode path: sudo xcode-select -s /Applications/Xcode.app"
      );
    }
  }

  private async launchWDA(
    wdaPath: string,
    deviceId: string,
    port: number
  ): Promise<void> {
    const existingInstance = this.instances.get(deviceId);
    if (existingInstance) {
      try {
        process.kill(existingInstance.pid, 0);
        return;
      } catch {
        this.instances.delete(deviceId);
      }
    }

    const wdaProcess = spawn(
      "xcodebuild",
      [
        "test-without-building",
        "-project",
        "WebDriverAgent.xcodeproj",
        "-scheme",
        "WebDriverAgentRunner",
        "-destination",
        `platform=iOS Simulator,id=${deviceId}`,
      ],
      {
        cwd: wdaPath,
        env: {
          ...process.env,
          USE_PORT: port.toString(),
        },
        stdio: "pipe",
      }
    );

    this.instances.set(deviceId, {
      pid: wdaProcess.pid!,
      port,
      deviceId,
    });

    const MAX_OUTPUT_CHARS = 50_000;
    let output = "";
    const appendOutput = (data: Buffer) => {
      output += data.toString();
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(output.length - MAX_OUTPUT_CHARS);
      }
    };
    wdaProcess.stdout?.on("data", appendOutput);
    wdaProcess.stderr?.on("data", appendOutput);

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
      } catch {
        // Continue waiting
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    try {
      process.kill(wdaProcess.pid!);
    } catch {}

    throw new Error(
      "WebDriverAgent failed to start within 30s.\n\n" +
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
        `Last output:\n${output.slice(-500)}`
    );
  }

  /**
   * Launch WDA on a PHYSICAL device. Unlike the simulator path we use
   * `xcodebuild test` (build+sign+install+run in one shot, automatic
   * provisioning) targeting the device destination, then forward the device's
   * WDA port to a local port via go-ios so the localhost WDAClient is unchanged.
   */
  private async launchWDADevice(
    wdaPath: string,
    udid: string,
    localPort: number
  ): Promise<void> {
    const existingInstance = this.instances.get(udid);
    if (existingInstance) {
      try {
        process.kill(existingInstance.pid, 0);
        this.ensureForward(udid, localPort);
        return;
      } catch {
        this.instances.delete(udid);
      }
    }

    const teamId = this.resolveTeamId();
    if (!teamId) {
      throw new Error(
        "No Apple Development team found for signing WebDriverAgent on a " +
          "physical device. Set IOS_TEAM_ID, or sign in to Xcode with an " +
          "Apple ID that has a development certificate."
      );
    }

    // The stock runner bundle id `com.facebook.WebDriverAgentRunner` belongs to
    // Facebook and cannot be provisioned under another team. Override it with a
    // team-unique id for physical signing (WDA_BUNDLE_ID), defaulting to one
    // derived from the team so automatic provisioning can register it.
    const bundleId = process.env.WDA_BUNDLE_ID ?? `com.${teamId}.WebDriverAgentRunner`;

    const wdaProcess = spawn(
      "xcodebuild",
      [
        "test",
        "-project",
        "WebDriverAgent.xcodeproj",
        "-scheme",
        "WebDriverAgentRunner",
        "-destination",
        `platform=iOS,id=${udid}`,
        "-allowProvisioningUpdates",
        `DEVELOPMENT_TEAM=${teamId}`,
        "CODE_SIGN_STYLE=Automatic",
        `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
      ],
      {
        cwd: wdaPath,
        env: { ...process.env, USE_PORT: DEVICE_WDA_PORT.toString() },
        stdio: "pipe",
      }
    );

    this.instances.set(udid, { pid: wdaProcess.pid!, port: localPort, deviceId: udid });

    const MAX_OUTPUT_CHARS = 50_000;
    let output = "";
    const appendOutput = (data: Buffer) => {
      output += data.toString();
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(output.length - MAX_OUTPUT_CHARS);
      }
    };
    wdaProcess.stdout?.on("data", appendOutput);
    wdaProcess.stderr?.on("data", appendOutput);
    wdaProcess.on("exit", () => {
      this.instances.delete(udid);
      this.clients.delete(udid);
      this.stopForward(udid);
    });

    // Forward device WDA port -> local port so localhost WDAClient works.
    this.ensureForward(udid, localPort);

    const startTime = Date.now();
    while (Date.now() - startTime < this.deviceStartupTimeout) {
      try {
        if (await this.checkHealth(localPort)) return;
      } catch {
        // keep waiting through the build
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    try {
      process.kill(wdaProcess.pid!);
    } catch {}
    this.stopForward(udid);

    throw new Error(
      "WebDriverAgent failed to start on the physical device within " +
        `${this.deviceStartupTimeout / 1000}s.\n\n` +
        "Troubleshooting:\n" +
        "1. Sign in to Xcode with the Apple ID for your team in Xcode > " +
        "Settings > Accounts (automatic provisioning needs an account, not " +
        "just a keychain certificate).\n" +
        "2. Set a team-unique WDA bundle id if signing the stock one fails: " +
        "export WDA_BUNDLE_ID=com.<you>.WebDriverAgentRunner\n" +
        "3. Enable Developer Mode on the device (Settings > Privacy & " +
        "Security > Developer Mode) and trust this Mac.\n" +
        "4. On iOS 17+, port-forward may need the go-ios tunnel: " +
        "`sudo ios tunnel start` (or ENABLE_GO_IOS_AGENT=user).\n\n" +
        `Last output:\n${output.slice(-800)}`
    );
  }

  /** Start (idempotently) an `ios forward localPort -> DEVICE_WDA_PORT`. */
  private ensureForward(udid: string, localPort: number): void {
    if (this.forwards.has(udid)) return;
    const fwd = spawn(
      GO_IOS_BIN,
      ["forward", "--udid", udid, localPort.toString(), DEVICE_WDA_PORT.toString()],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    fwd.on("exit", () => this.forwards.delete(udid));
    this.forwards.set(udid, fwd);
  }

  private stopForward(udid: string): void {
    const fwd = this.forwards.get(udid);
    if (fwd) {
      try {
        fwd.kill();
      } catch {}
      this.forwards.delete(udid);
    }
  }

  /** Team ID for signing: explicit env wins, else first codesigning identity. */
  private resolveTeamId(): string | undefined {
    if (process.env.IOS_TEAM_ID) return process.env.IOS_TEAM_ID;
    if (process.env.WDA_TEAM_ID) return process.env.WDA_TEAM_ID;
    try {
      const out = execSync("security find-identity -v -p codesigning", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const match = out.match(/\(([A-Z0-9]{10})\)/);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private async checkHealth(port: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`http://localhost:${port}/status`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);

      return response.ok;
    } catch {
      return false;
    }
  }

  private async findFreePort(): Promise<number> {
    const { createServer } = await import("net");

    for (let port = 8100; port < 8200; port++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const server = createServer();
          server.once("error", reject);
          server.once("listening", () => {
            server.close(() => resolve());
          });
          server.listen(port);
        });
        return port;
      } catch {
        continue;
      }
    }

    throw new Error("No free ports available in range 8100-8200");
  }

  cleanup(): void {
    for (const [deviceId, instance] of this.instances) {
      try {
        process.kill(instance.pid);
      } catch {}
      const client = this.clients.get(deviceId);
      if (client) {
        client.deleteSession().catch(() => {});
      }
    }
    for (const udid of [...this.forwards.keys()]) {
      this.stopForward(udid);
    }
    this.instances.clear();
    this.clients.clear();
  }
}
