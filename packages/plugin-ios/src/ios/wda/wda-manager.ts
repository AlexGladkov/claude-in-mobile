import { execFileSync, spawn } from "child_process";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createServer } from "net";
import { WDAClient } from "./wda-client.js";
import { pickBuildSimulator } from "./wda-build.js";
import { execSimctl } from "../simctl-exec.js";
import { parseDevicesJson } from "../simctl-parsers.js";
import type { WDAInstanceInfo } from "./wda-types.js";
import type { IosDevice } from "../types.js";
import { sanitizeErrorMessage } from "mcp-devices/utils/sanitize";

const DEVICE_WDA_PORT = 8100;
const GO_IOS_BIN = process.env.GO_IOS_BIN ?? "ios";
const RESERVED_PORTS = new Set<number>();

interface ManagedInstance extends WDAInstanceInfo {
  child: ChildProcess;
  generation: symbol;
}

interface ManagedForward {
  child: ChildProcess;
  generation: symbol;
  port: number;
}

export class WDAManager {
  private readonly instances = new Map<string, ManagedInstance>();
  private readonly clients = new Map<string, WDAClient>();
  private readonly launchPromises = new Map<string, Promise<WDAClient>>();
  private readonly forwards = new Map<string, ManagedForward>();
  private readonly startupTimeout = 30_000;
  private readonly deviceStartupTimeout = 300_000;
  private readonly buildTimeout = 120_000;
  private readonly derivedDataPath = path.join(os.homedir(), "Library/Caches/mcp-devices/WebDriverAgent");
  private disposed = false;
  private cleanupPromise?: Promise<void>;

  isClientActive(deviceId: string, client: WDAClient): boolean {
    const instance = this.instances.get(deviceId);
    return (
      this.clients.get(deviceId) === client
      && instance !== undefined
      && instance.child.exitCode === null
      && instance.child.signalCode === null
    );
  }

  async ensureWDAReady(deviceId: string, isSimulator = true): Promise<WDAClient> {
    if (this.disposed) throw new Error("WebDriverAgent manager is disposed");

    const existingClient = this.clients.get(deviceId);
    if (existingClient && this.isClientActive(deviceId, existingClient)) {
      try {
        await existingClient.ensureSession(deviceId);
        return existingClient;
      } catch (error) {
        console.error(
          "WDA client failed, relaunching:",
          sanitizeErrorMessage(error instanceof Error ? error.message : String(error)).slice(0, 1000),
        );
        await existingClient.deleteSession();
        await this.stopDevice(deviceId);
      }
    } else if (existingClient) {
      await this.stopDevice(deviceId);
    }

    const inFlight = this.launchPromises.get(deviceId);
    if (inFlight) return inFlight;

    const launch = this.doLaunch(deviceId, isSimulator);
    this.launchPromises.set(deviceId, launch);
    try {
      return await launch;
    } finally {
      if (this.launchPromises.get(deviceId) === launch) {
        this.launchPromises.delete(deviceId);
      }
    }
  }

  private async doLaunch(deviceId: string, isSimulator: boolean): Promise<WDAClient> {
    const live = this.liveInstance(deviceId);
    if (live) {
      if (!isSimulator) await this.ensureForward(deviceId, live.port, live.generation);
      const client = new WDAClient(live.port);
      try {
        await client.ensureSession(deviceId);
        if (this.disposed || this.instances.get(deviceId) !== live) {
          throw new Error("WebDriverAgent launch was cancelled");
        }
        this.clients.set(deviceId, client);
        return client;
      } catch (error) {
        await client.deleteSession();
        await this.stopDevice(deviceId, live);
        throw error;
      }
    }

    const wdaPath = await this.discoverWDA();
    if (isSimulator) await this.buildWDAIfNeeded(wdaPath);
    const port = await this.reservePort();
    let instance: ManagedInstance | undefined;
    let client: WDAClient | undefined;
    try {
      if (this.disposed) throw new Error("WebDriverAgent launch was cancelled");
      instance = isSimulator
        ? await this.launchSimulator(wdaPath, deviceId, port)
        : await this.launchDevice(wdaPath, deviceId, port);
      client = new WDAClient(instance.port);
      await client.ensureSession(deviceId);
      if (this.disposed || this.instances.get(deviceId) !== instance) {
        throw new Error("WebDriverAgent launch was cancelled");
      }
      this.clients.set(deviceId, client);
      return client;
    } catch (error) {
      await client?.deleteSession();
      const published = instance ?? this.instances.get(deviceId);
      if (published?.port === port) await this.stopDevice(deviceId, published);
      else RESERVED_PORTS.delete(port);
      throw error;
    }
  }

  private liveInstance(deviceId: string): ManagedInstance | undefined {
    const instance = this.instances.get(deviceId);
    if (!instance) return undefined;
    if (instance.child.exitCode === null && instance.child.signalCode === null) return instance;
    if (this.instances.get(deviceId) === instance) this.instances.delete(deviceId);
    void this.stopForward(deviceId, instance.generation);
    RESERVED_PORTS.delete(instance.port);
    return undefined;
  }

  private async discoverWDA(): Promise<string> {
    const searchPaths = [
      process.env.WDA_PATH,
      path.join(os.homedir(), ".appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent"),
      "/opt/homebrew/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent",
      "/usr/local/lib/node_modules/appium/node_modules/appium-xcuitest-driver/node_modules/appium-webdriveragent",
    ].filter(Boolean) as string[];

    for (const searchPath of searchPaths) {
      if (fs.existsSync(path.join(searchPath, "WebDriverAgent.xcodeproj"))) return searchPath;
    }
    throw new Error(
      "WebDriverAgent not found.\n\n" +
      "Install Appium with XCUITest driver:\n" +
      "  npm install -g appium\n" +
      "  appium driver install xcuitest\n\n" +
      "Or set WDA_PATH environment variable.\n\n" +
      `Search paths checked:\n${searchPaths.map((entry) =>
        `  - ${sanitizeErrorMessage(entry).slice(0, 1000)}`
      ).join("\n")}`,
    );
  }

  private resolveSimulatorDestination(devices: IosDevice[]): string {
    const device = pickBuildSimulator(devices);
    if (!device) {
      throw new Error(
        "No iOS simulator available to build WebDriverAgent against. "
        + "Create one in Xcode (Window > Devices and Simulators).",
      );
    }
    return `platform=iOS Simulator,id=${device.id}`;
  }

  private async buildWDAIfNeeded(wdaPath: string): Promise<void> {
    const devices = parseDevicesJson(execSimctl(["list", "devices", "-j"]));
    const destination = this.resolveSimulatorDestination(devices);
    console.error("Preparing WebDriverAgent for first use...");
    try {
      // Always invoke xcodebuild: its incremental build graph is the reliable
      // freshness check. A filesystem probe cannot distinguish another WDA
      // checkout or stale sources from the project being launched.
      execFileSync("xcodebuild", [
        "build-for-testing",
        "-project", "WebDriverAgent.xcodeproj",
        "-scheme", "WebDriverAgentRunner",
        "-destination", destination,
        "-derivedDataPath", this.derivedDataPath,
        "CODE_SIGNING_ALLOWED=NO",
      ], {
        cwd: wdaPath,
        timeout: this.buildTimeout,
        stdio: "pipe",
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (error) {
      const details = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
      const message = details.stderr?.toString() || details.stdout?.toString() || details.message || String(error);
      throw new Error(
        `Failed to build WebDriverAgent.\n\n${sanitizeErrorMessage(message).slice(0, 4096)}`,
      );
    }
  }

  private async launchSimulator(
    wdaPath: string,
    deviceId: string,
    port: number,
  ): Promise<ManagedInstance> {
    const child = spawn("xcodebuild", [
      "test-without-building",
      "-project", "WebDriverAgent.xcodeproj",
      "-scheme", "WebDriverAgentRunner",
      "-destination", `platform=iOS Simulator,id=${deviceId}`,
      "-derivedDataPath", this.derivedDataPath,
    ], {
      cwd: wdaPath,
      env: { ...process.env, USE_PORT: String(port) },
      stdio: "pipe",
    });
    const instance = this.publishInstance(deviceId, port, child);
    const output = this.captureOutput(child);
    const healthy = await this.waitForHealth(
      port,
      this.startupTimeout,
      () => child.exitCode !== null || child.signalCode !== null,
    );
    if (!healthy) {
      throw new Error(
        `WebDriverAgent failed to start within 30s.\n\nLast output:\n${sanitizeErrorMessage(output()).slice(-500)}`,
      );
    }
    return instance;
  }

  private async launchDevice(
    wdaPath: string,
    deviceId: string,
    port: number,
  ): Promise<ManagedInstance> {
    const teamId = this.resolveTeamId();
    if (!teamId) {
      throw new Error(
        "No Apple Development team found for signing WebDriverAgent on a physical device. " +
        "Set IOS_TEAM_ID, or sign in to Xcode with an Apple ID.",
      );
    }
    const bundleId = process.env.WDA_BUNDLE_ID ?? `com.${teamId}.WebDriverAgentRunner`;
    const child = spawn("xcodebuild", [
      "test",
      "-project", "WebDriverAgent.xcodeproj",
      "-scheme", "WebDriverAgentRunner",
      "-destination", `platform=iOS,id=${deviceId}`,
      "-allowProvisioningUpdates",
      `DEVELOPMENT_TEAM=${teamId}`,
      "CODE_SIGN_STYLE=Automatic",
      `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
    ], {
      cwd: wdaPath,
      env: { ...process.env, USE_PORT: String(DEVICE_WDA_PORT) },
      stdio: "pipe",
    });
    const instance = this.publishInstance(deviceId, port, child);
    const output = this.captureOutput(child);
    await this.ensureForward(deviceId, port, instance.generation);
    const healthy = await this.waitForHealth(
      port,
      this.deviceStartupTimeout,
      () => child.exitCode !== null || child.signalCode !== null,
    );
    if (!healthy) {
      throw new Error(
        `Failed to start WebDriverAgent on the physical device.\n\nLast output:\n${sanitizeErrorMessage(output()).slice(-800)}`,
      );
    }
    return instance;
  }

  private publishInstance(deviceId: string, port: number, child: ChildProcess): ManagedInstance {
    if (!child.pid || child.pid <= 1) {
      child.kill();
      throw new Error("WebDriverAgent process did not provide a valid pid");
    }
    const instance: ManagedInstance = {
      pid: child.pid,
      port,
      deviceId,
      child,
      generation: Symbol(deviceId),
    };
    this.instances.set(deviceId, instance);
    child.once("exit", () => {
      if (this.instances.get(deviceId) !== instance) return;
      this.instances.delete(deviceId);
      this.clients.delete(deviceId);
      void this.stopForward(deviceId, instance.generation);
      RESERVED_PORTS.delete(port);
    });
    child.once("error", () => {
      if (this.instances.get(deviceId) !== instance) return;
      this.instances.delete(deviceId);
      this.clients.delete(deviceId);
      void this.stopForward(deviceId, instance.generation);
      RESERVED_PORTS.delete(port);
    });
    return instance;
  }

  private captureOutput(child: ChildProcess): () => string {
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 50_000) output = output.slice(-50_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    return () => output;
  }

  private async ensureForward(
    deviceId: string,
    port: number,
    generation: symbol,
  ): Promise<ManagedForward> {
    const existing = this.forwards.get(deviceId);
    if (
      existing
      && existing.port === port
      && existing.child.exitCode === null
      && existing.child.signalCode === null
    ) return existing;
    if (existing) await this.stopForward(deviceId, existing.generation);
    const child = spawn(GO_IOS_BIN, [
      "forward", "--udid", deviceId, String(port), String(DEVICE_WDA_PORT),
    ], { stdio: ["ignore", "ignore", "ignore"] });
    const forward = { child, generation, port };
    this.forwards.set(deviceId, forward);
    const clear = () => {
      if (this.forwards.get(deviceId) === forward) this.forwards.delete(deviceId);
    };
    child.once("exit", clear);
    child.once("error", clear);
    return forward;
  }

  private async stopForward(deviceId: string, generation?: symbol): Promise<void> {
    const forward = this.forwards.get(deviceId);
    if (!forward || (generation && forward.generation !== generation)) return;
    this.forwards.delete(deviceId);
    await this.terminateChild(forward.child);
  }

  private resolveTeamId(): string | undefined {
    if (process.env.IOS_TEAM_ID) return process.env.IOS_TEAM_ID;
    if (process.env.WDA_TEAM_ID) return process.env.WDA_TEAM_ID;
    try {
      const output = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
        encoding: "utf-8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      return output.match(/\(([A-Z0-9]{10})\)/)?.[1];
    } catch {
      return undefined;
    }
  }

  private async checkHealth(port: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        redirect: "error",
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => {});
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async waitForHealth(
    port: number,
    timeoutMs: number,
    exited: () => boolean,
  ): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this.checkHealth(port)) return true;
      if (exited() || this.disposed) return false;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return false;
  }

  private async reservePort(): Promise<number> {
    for (let port = 8_100; port < 8_200; port++) {
      if (RESERVED_PORTS.has(port)) continue;
      const available = await new Promise<boolean>((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.once("listening", () => {
          RESERVED_PORTS.add(port);
          server.close(() => resolve(true));
        });
        // Match WebDriverAgent's IPv4 wildcard bind exactly. Omitting host lets
        // Node choose IPv6 `::`, which can coexist with an occupied 0.0.0.0 port.
        server.listen(port, "0.0.0.0");
      });
      if (available) return port;
    }
    throw new Error("No free ports available in range 8100-8200");
  }

  private async stopDevice(deviceId: string, expected?: ManagedInstance): Promise<void> {
    const instance = this.instances.get(deviceId);
    if (expected && instance !== expected) return;
    this.clients.delete(deviceId);
    if (!instance) {
      await this.stopForward(deviceId);
      return;
    }
    this.instances.delete(deviceId);
    await Promise.allSettled([
      this.stopForward(deviceId, instance.generation),
      this.terminateChild(instance.child),
    ]);
    RESERVED_PORTS.delete(instance.port);
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const gracefulExit = this.waitForExit(child, 1_000);
    try { child.kill("SIGTERM"); } catch {}
    if (await gracefulExit) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const forcedExit = this.waitForExit(child, 1_000);
    try { child.kill("SIGKILL"); } catch {}
    await forcedExit;
  }

  private waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) finish(true);
    });
  }

  async cleanup(): Promise<void> {
    if (!this.cleanupPromise) this.cleanupPromise = this.runCleanup();
    return this.cleanupPromise;
  }

  private async runCleanup(): Promise<void> {
    this.disposed = true;
    const launches = [...this.launchPromises.values()];
    const clients = [...this.clients.values()];
    const instances = [...this.instances.entries()];
    const forwards = [...this.forwards];
    await Promise.allSettled([
      ...instances.map(([deviceId, instance]) => this.stopDevice(deviceId, instance)),
      ...forwards.map(([deviceId, forward]) =>
        this.stopForward(deviceId, forward.generation)
      ),
    ]);
    await Promise.allSettled(launches);
    await Promise.allSettled(clients.map((client) => client.deleteSession()));
    this.clients.clear();
    this.launchPromises.clear();
  }
}
