import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync, unlinkSync } from "fs";
import { WDAManager, WDAClient, WDAElement, WDARect } from "./wda/index.js";
import { classifySimctlError } from "../errors.js";
import { validateDeviceId, validateBundleId } from "../utils/sanitize.js";

const EXEC_TIMEOUT_MS = 15_000;      // 15s for text commands

/**
 * Split a whitespace-separated command into argv tokens.
 * Safe for commands that do not contain shell-quoted strings (no embedded spaces inside an arg).
 * For commands with spaces inside arguments (e.g. file paths), use execArgs() directly.
 */
function splitArgs(command: string): string[] {
  return command.split(/\s+/).filter(Boolean);
}

export interface IosDevice {
  id: string;
  name: string;
  state: string;
  runtime: string;
  isSimulator: boolean;
}

export class IosClient {
  private deviceId?: string;
  private wdaManager: WDAManager = new WDAManager();
  private wdaClient?: WDAClient;

  constructor(deviceId?: string) {
    if (deviceId) {
      validateDeviceId(deviceId);
    }
    this.deviceId = deviceId;
  }

  cleanup(): void {
    this.wdaManager.cleanup();
    this.wdaClient = undefined;
  }

  private async ensureWDA(deviceIdOverride?: string): Promise<WDAClient> {
    const effectiveId = deviceIdOverride ?? this.deviceId;

    if (!effectiveId) {
      const booted = this.getBootedDevices();
      if (booted.length === 0) {
        throw new Error("No booted iOS simulator found. Boot a simulator first.");
      }
      this.deviceId = booted[0].id;
      this.wdaClient = await this.wdaManager.ensureWDAReady(this.deviceId);
      return this.wdaClient;
    }

    // Per-call override: don't cache on instance if different from default
    if (deviceIdOverride && deviceIdOverride !== this.deviceId) {
      return this.wdaManager.ensureWDAReady(deviceIdOverride);
    }

    if (!this.wdaClient) {
      this.wdaClient = await this.wdaManager.ensureWDAReady(effectiveId);
    }
    return this.wdaClient;
  }

  /**
   * SECURITY: All simctl invocations route through this argv-form path
   * (execFileSync — no /bin/sh -c). Shell metacharacters in `args` are passed as
   * literal argv slots, not parsed by the host shell. This structurally prevents
   * host-side OS Command Injection (CWE-78) — see issue #40.
   *
   * Note: `xcrun simctl` and its sub-tools (e.g. `log show --predicate`) parse their
   * own arguments internally; predicate strings travel as a single argv slot, so
   * they reach simctl verbatim without /bin/sh expansion.
   */
  private execArgs(args: string[]): string {
    const fullArgs = ["simctl", ...args];
    try {
      return execFileSync("xcrun", fullArgs, {
        encoding: "utf-8",
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024,
      }).trim();
    } catch (error: unknown) {
      const e = error as { killed?: boolean; signal?: string; stderr?: Buffer | string; message?: string };
      const display = `xcrun ${fullArgs.join(" ")}`;
      if (e.killed === true || e.signal === "SIGTERM") {
        throw new Error(`simctl command timed out after ${EXEC_TIMEOUT_MS}ms: ${display}. Simulator may be unresponsive.`);
      }
      throw classifySimctlError(e.stderr?.toString() ?? e.message ?? String(error), display);
    }
  }

  /**
   * Variant of execArgs that suppresses stderr (used by fallback log paths
   * that previously relied on shell `2>/dev/null`).
   * Same SECURITY guarantee as execArgs — argv form, no shell parsing.
   */
  private execArgsQuiet(args: string[]): string {
    const fullArgs = ["simctl", ...args];
    try {
      const out = execFileSync("xcrun", fullArgs, {
        encoding: "utf-8",
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.toString().trim();
    } catch (error: unknown) {
      const e = error as { killed?: boolean; signal?: string; stderr?: Buffer | string; message?: string };
      const display = `xcrun ${fullArgs.join(" ")}`;
      if (e.killed === true || e.signal === "SIGTERM") {
        throw new Error(`simctl command timed out after ${EXEC_TIMEOUT_MS}ms: ${display}. Simulator may be unresponsive.`);
      }
      throw classifySimctlError(e.stderr?.toString() ?? e.message ?? String(error), display);
    }
  }

  /**
   * Execute simctl command (legacy string form). Whitespace-split into argv tokens.
   * SECURITY: Shell metacharacters in `command` are NOT interpreted — the split tokens
   * pass to execFileSync as distinct argv slots (no /bin/sh -c). For commands that
   * require an argument containing spaces (e.g. file paths), call execArgs() directly.
   */
  private exec(command: string): string {
    return this.execArgs(splitArgs(command));
  }

  /**
   * Get the active device ID or 'booted'
   */
  private get targetDevice(): string {
    return this.deviceId ?? "booted";
  }

  /** Resolve target device for a per-call override or fall back to instance default. */
  private targetDeviceFor(deviceIdOverride?: string): string {
    return deviceIdOverride ?? this.deviceId ?? "booted";
  }

  /**
   * Get list of iOS simulators
   */
  getDevices(): IosDevice[] {
    const output = this.exec("list devices -j");
    const data = JSON.parse(output);
    const devices: IosDevice[] = [];

    for (const [runtime, deviceList] of Object.entries(data.devices)) {
      if (!Array.isArray(deviceList)) continue;

      for (const device of deviceList as Array<{ isAvailable?: boolean; udid: string; name: string; state: string }>) {
        // Only include available devices
        if (device.isAvailable) {
          devices.push({
            id: device.udid,
            name: device.name,
            state: device.state.toLowerCase(),
            runtime: runtime.replace("com.apple.CoreSimulator.SimRuntime.", ""),
            isSimulator: true
          });
        }
      }
    }

    return devices;
  }

  /**
   * Get booted simulators
   */
  getBootedDevices(): IosDevice[] {
    return this.getDevices().filter(d => d.state === "booted");
  }

  /**
   * Set active device
   */
  setDevice(deviceId: string): void {
    validateDeviceId(deviceId);
    if (this.deviceId !== deviceId) {
      this.wdaClient = undefined;
    }
    this.deviceId = deviceId;
  }

  /**
   * Get currently configured device ID
   */
  getDeviceId(): string | undefined {
    return this.deviceId;
  }

  /**
   * Boot simulator
   */
  boot(deviceId?: string): void {
    const target = deviceId ?? this.deviceId;
    if (!target) throw new Error("No device specified");
    validateDeviceId(target);
    this.execArgs(["boot", target]);
  }

  /**
   * Shutdown simulator
   */
  shutdown(deviceId?: string): void {
    const target = deviceId ?? this.deviceId ?? "booted";
    if (target !== "booted") validateDeviceId(target);
    this.execArgs(["shutdown", target]);
  }

  /**
   * Take screenshot and return raw PNG buffer
   */
  screenshotRaw(deviceIdOverride?: string): Buffer {
    const target = this.targetDeviceFor(deviceIdOverride);
    const tmpFile = join(tmpdir(), `ios-screenshot-${Date.now()}.png`);
    try {
      // Path passed as distinct argv slot — spaces in tmpdir are safe.
      this.execArgs(["io", target, "screenshot", tmpFile]);
      return readFileSync(tmpFile);
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  /**
   * Take screenshot and return as base64 (legacy)
   */
  screenshot(deviceIdOverride?: string): string {
    return this.screenshotRaw(deviceIdOverride).toString("base64");
  }

  /**
   * Tap at coordinates
   */
  async tap(x: number, y: number, deviceIdOverride?: string): Promise<void> {
    try {
      const wdaClient = await this.ensureWDA(deviceIdOverride);
      await wdaClient.tapByCoordinates(x, y);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Tap requires WebDriverAgent.\n\n` +
        `Install: npm install -g appium && appium driver install xcuitest\n` +
        `Or set WDA_PATH environment variable.\n\n` +
        `Error: ${msg}`
      );
    }
  }

  /**
   * Swipe gesture
   */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number = 300, deviceIdOverride?: string): Promise<void> {
    try {
      const wdaClient = await this.ensureWDA(deviceIdOverride);
      await wdaClient.swipe(x1, y1, x2, y2, durationMs);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Swipe requires WebDriverAgent.\n\n` +
        `Install: npm install -g appium && appium driver install xcuitest\n` +
        `Or set WDA_PATH environment variable.\n\n` +
        `Error: ${msg}`
      );
    }
  }

  /**
   * Long press at coordinates via WDA Actions API
   */
  async longPress(x: number, y: number, durationMs: number = 1000, deviceIdOverride?: string): Promise<void> {
    try {
      const wdaClient = await this.ensureWDA(deviceIdOverride);
      await wdaClient.longPress(x, y, durationMs);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Long press requires WebDriverAgent.\n\n` +
        `Install: npm install -g appium && appium driver install xcuitest\n` +
        `Or set WDA_PATH environment variable.\n\n` +
        `Error: ${msg}`
      );
    }
  }

  /**
   * Swipe in direction (uses actual screen center from WDA, not hardcoded)
   */
  async swipeDirection(direction: "up" | "down" | "left" | "right", distance: number = 400): Promise<void> {
    // Get actual screen size from WDA instead of using hardcoded values
    let centerX = 200;
    let centerY = 400;

    try {
      const wdaClient = await this.ensureWDA();
      const size = await wdaClient.getWindowSize();
      centerX = Math.floor(size.width / 2);
      centerY = Math.floor(size.height / 2);
    } catch {
      // Fallback to defaults if WDA not available
    }

    const coords = {
      up: [centerX, centerY + distance/2, centerX, centerY - distance/2],
      down: [centerX, centerY - distance/2, centerX, centerY + distance/2],
      left: [centerX + distance/2, centerY, centerX - distance/2, centerY],
      right: [centerX - distance/2, centerY, centerX + distance/2, centerY],
    };

    const [x1, y1, x2, y2] = coords[direction];
    await this.swipe(x1, y1, x2, y2);
  }

  /**
   * Input text via WDA (types into the currently focused element)
   */
  async inputText(text: string, deviceIdOverride?: string): Promise<void> {
    try {
      const wdaClient = await this.ensureWDA(deviceIdOverride);
      await wdaClient.typeText(text);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Text input requires WebDriverAgent.\n\n` +
        `Install: npm install -g appium && appium driver install xcuitest\n` +
        `Or set WDA_PATH environment variable.\n\n` +
        `Error: ${msg}`
      );
    }
  }

  /**
   * Press key
   *
   * SECURITY: AppleScript invocations use execFileSync("osascript", ["-e", literal])
   * — the script literal is a single argv slot, so /bin/sh never parses its contents.
   * The `key` argument is whitelisted via keyMap; only fixed AppleScript literals reach
   * osascript.
   */
  pressKey(key: string): void {
    const keyMap: Record<string, string> = {
      "HOME": "home",
      "BACK": "home", // iOS doesn't have back, use home
      "VOLUME_UP": "volumeUp",
      "VOLUME_DOWN": "volumeDown",
      "LOCK": "lock",
    };

    const mappedKey = keyMap[key.toUpperCase()] ?? key.toLowerCase();

    // Use simctl io for button presses
    if (mappedKey === "home") {
      this.execArgs(["io", this.targetDevice, "enumerate"]);
      // Trigger home button via keyboard shortcut
      execFileSync(
        "osascript",
        [
          "-e", 'tell application "Simulator" to activate',
          "-e", 'tell application "System Events" to keystroke "h" using {command down, shift down}',
        ],
        { encoding: "utf-8", timeout: EXEC_TIMEOUT_MS }
      );
    } else {
      // Try generic approach
      execFileSync(
        "osascript",
        ["-e", 'tell application "Simulator" to activate'],
        { encoding: "utf-8", timeout: EXEC_TIMEOUT_MS }
      );
    }
  }

  /**
   * Launch app by bundle ID
   */
  launchApp(bundleId: string, deviceIdOverride?: string): string {
    validateBundleId(bundleId);
    this.execArgs(["launch", this.targetDeviceFor(deviceIdOverride), bundleId]);
    return `Launched ${bundleId}`;
  }

  /**
   * Terminate app
   */
  stopApp(bundleId: string, deviceIdOverride?: string): void {
    validateBundleId(bundleId);
    try {
      this.execArgs(["terminate", this.targetDeviceFor(deviceIdOverride), bundleId]);
    } catch {
      // App might not be running
    }
  }

  /**
   * Install app (.app bundle or .ipa)
   */
  installApp(path: string): string {
    // Path passed as distinct argv slot — spaces in path are safe; no shell parsing.
    this.execArgs(["install", this.targetDevice, path]);
    return `Installed ${path}`;
  }

  /**
   * Uninstall app
   */
  uninstallApp(bundleId: string): string {
    validateBundleId(bundleId);
    this.execArgs(["uninstall", this.targetDevice, bundleId]);
    return `Uninstalled ${bundleId}`;
  }

  /**
   * Get UI hierarchy (limited on iOS simulator)
   * Returns accessibility info if available
   */
  async getUiHierarchy(deviceIdOverride?: string): Promise<string> {
    try {
      const wdaClient = await this.ensureWDA(deviceIdOverride);
      const tree = await wdaClient.getAccessibleSource();
      return JSON.stringify(tree, null, 2);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `WebDriverAgent required for iOS UI inspection.\n\n` +
        `Install: npm install -g appium && appium driver install xcuitest\n` +
        `Or set WDA_PATH environment variable.\n\n` +
        `Error: ${msg}`
      );
    }
  }

  /**
   * Find element by text or label
   */
  async findElement(criteria: { text?: string; label?: string }): Promise<WDAElement> {
    const wdaClient = await this.ensureWDA();

    if (criteria.label) {
      return await wdaClient.findElement("accessibility id", criteria.label);
    }
    if (criteria.text) {
      return await wdaClient.findElement("name", criteria.text);
    }

    throw new Error("Provide text or label to find element");
  }

  /**
   * Find multiple elements by criteria
   */
  async findElements(criteria: {
    text?: string;
    label?: string;
    type?: string;
    visible?: boolean;
  }): Promise<Array<{ id: string; type: string; label: string; rect: WDARect }>> {
    const wdaClient = await this.ensureWDA();
    const elements: WDAElement[] = [];

    if (criteria.text) {
      const found = await wdaClient.findElements("name", criteria.text);
      elements.push(...found);
    }
    if (criteria.label) {
      const found = await wdaClient.findElements("accessibility id", criteria.label);
      elements.push(...found);
    }
    if (criteria.type) {
      const found = await wdaClient.findElements("class name", criteria.type);
      elements.push(...found);
    }

    const results = await Promise.all(
      elements.map(async (el) => {
        try {
          const rect = await wdaClient.getElementRect(el.ELEMENT);
          const text = await wdaClient.getElementText(el.ELEMENT).catch(() => "");
          const displayed =
            criteria.visible !== undefined
              ? await wdaClient.isElementDisplayed(el.ELEMENT)
              : true;

          if (criteria.visible !== undefined && displayed !== criteria.visible) {
            return null;
          }

          return {
            id: el.ELEMENT,
            type: criteria.type || "Unknown",
            label: text,
            rect,
          };
        } catch {
          return null;
        }
      })
    );

    return results.filter((r): r is NonNullable<typeof r> => r !== null);
  }

  /**
   * Get element rect (position + size) by element ID
   */
  async getElementRect(elementId: string): Promise<WDARect | null> {
    try {
      const wdaClient = await this.ensureWDA();
      return await wdaClient.getElementRect(elementId);
    } catch {
      return null;
    }
  }

  /**
   * Tap element by element ID
   */
  async tapElement(elementId: string): Promise<void> {
    const wdaClient = await this.ensureWDA();
    await wdaClient.clickElement(elementId);
  }

  /**
   * Open URL in simulator
   *
   * SECURITY: URL passes as a single argv slot to xcrun (no /bin/sh -c).
   * Any shell metacharacters in `url` are not parsed by the host shell.
   * Scheme validation happens at the tool layer (validateUrl).
   */
  openUrl(url: string): void {
    try {
      this.execArgs(["openurl", this.targetDevice, url]);
    } catch (error: unknown) {
      const e = error as { stderr?: Buffer | string; message?: string };
      throw classifySimctlError(e.stderr?.toString() ?? e.message ?? String(error), `simctl openurl ${url}`);
    }
  }

  /**
   * Add photo to simulator
   */
  addPhoto(imagePath: string): void {
    // Path passed as distinct argv slot — spaces in path are safe.
    this.execArgs(["addmedia", this.targetDevice, imagePath]);
  }

  /**
   * Set location
   */
  setLocation(lat: number, lon: number): void {
    // Coerce to finite numbers — simctl expects `lat,lon` as a single argument.
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!Number.isFinite(latN) || !Number.isFinite(lonN)) {
      throw new Error(`Invalid coordinates: lat=${lat}, lon=${lon}`);
    }
    this.execArgs(["location", this.targetDevice, "set", `${latN},${lonN}`]);
  }

  /**
   * Get device info
   */
  getDeviceInfo(): Record<string, string> {
    const output = this.execArgs(["getenv", this.targetDevice, "SIMULATOR_DEVICE_NAME"]);
    return { name: output };
  }

  /**
   * Execute arbitrary simctl command
   *
   * SECURITY: `command` is whitespace-split into argv tokens before reaching
   * execFileSync. Shell metacharacters (;, &, |, $(), backticks, etc.) cannot
   * spawn a host shell from this path. The MCP tool layer additionally validates
   * via validateShellCommand as defense in depth.
   */
  shell(command: string): string {
    return this.exec(command);
  }

  /**
   * Get device logs
   */
  getLogs(options: {
    predicate?: string;
    lines?: number;
    level?: "debug" | "info" | "default" | "error" | "fault";
  } = {}): string {
    const buildArgs = (lastWindow: string): string[] => {
      const args: string[] = ["spawn", this.targetDevice, "log", "show", "--style", "compact", "--last", lastWindow];
      // Filter by level
      if (options.level) {
        // Predicate string is a single argv slot — simctl parses it internally, not /bin/sh.
        args.push("--predicate", `messageType == ${options.level}`);
      }
      // Custom predicate (user-controlled, but passes as one argv slot — no shell parsing)
      if (options.predicate) {
        args.push("--predicate", options.predicate);
      }
      return args;
    };

    try {
      const output = this.execArgs(buildArgs("5m"));

      // Limit lines if specified (Node-side slice replaces the prior shell `| tail`).
      if (options.lines) {
        const linesN = Math.trunc(Math.max(0, options.lines));
        const lines = output.split("\n");
        return lines.slice(-linesN).join("\n");
      }

      return output;
    } catch {
      // Fallback: try system log (last 1m, swallow stderr — replaces prior `2>/dev/null`).
      try {
        const fallback = this.execArgsQuiet([
          "spawn", this.targetDevice, "log", "show", "--style", "compact", "--last", "1m",
        ]);
        // Node-side slice replaces the prior shell `| tail -100`.
        return fallback.split("\n").slice(-100).join("\n");
      } catch {
        return "Unable to retrieve logs. Make sure the simulator is running.";
      }
    }
  }

  /**
   * Get app-specific logs
   *
   * SECURITY: bundleId is validated against the reverse-DNS whitelist before
   * embedding into the simctl predicate string. The predicate itself is passed
   * as ONE argv slot — the host shell never parses it; simctl parses it
   * internally as its own DSL.
   */
  getAppLogs(bundleId: string, lines: number = 100): string {
    validateBundleId(bundleId);
    const linesN = Math.trunc(Math.max(0, lines));
    try {
      const output = this.execArgs([
        "spawn", this.targetDevice, "log", "show", "--style", "compact",
        "--last", "5m",
        "--predicate", `subsystem == "${bundleId}"`,
      ]);
      // Node-side slice replaces prior shell `| tail -${lines}`.
      return output.split("\n").slice(-linesN).join("\n");
    } catch {
      return `Unable to retrieve logs for ${bundleId}`;
    }
  }

  /**
   * Clear logs (not fully supported on iOS, but we can note the timestamp)
   */
  clearLogs(): string {
    return "iOS simulator logs cannot be cleared. Use --last parameter to filter recent logs.";
  }

  /**
   * Grant privacy permission on iOS simulator
   * Services: camera, microphone, photos, location, contacts, calendar, reminders, motion, health, speech-recognition
   */
  grantPermission(bundleId: string, service: string): string {
    validateBundleId(bundleId);
    return this.execArgs(["privacy", this.targetDevice, "grant", service, bundleId]);
  }

  /**
   * Revoke privacy permission on iOS simulator
   */
  revokePermission(bundleId: string, service: string): string {
    validateBundleId(bundleId);
    return this.execArgs(["privacy", this.targetDevice, "revoke", service, bundleId]);
  }

  /**
   * Reset all privacy permissions for an app on iOS simulator
   */
  resetPermissions(bundleId: string): string {
    validateBundleId(bundleId);
    return this.execArgs(["privacy", this.targetDevice, "reset", "all", bundleId]);
  }
}
