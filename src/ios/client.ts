import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync, unlinkSync } from "fs";
import { WDAManager, WDAClient, WDAElement, WDARect } from "./wda/index.js";
import { classifySimctlError } from "../errors.js";
import { validateDeviceId, validateBundleId } from "../utils/sanitize.js";
import { execSimctl, execSimctlQuiet, SIMCTL_EXEC_TIMEOUT_MS } from "./simctl-exec.js";
import type { IosDevice } from "./types.js";
import {
  buildAppLogArgs,
  buildLogShowArgs,
  formatLatLon,
  sliceLastLines,
  splitArgs,
} from "./simctl-commands.js";
import { parseDevicesJson } from "./simctl-parsers.js";
import { listPhysicalDevices } from "./go-ios/index.js";
import { wdaRequiredError } from "./wda-errors.js";
import {
  ACTIVATE_SIMULATOR_OSASCRIPT_ARGS,
  HOME_KEY_OSASCRIPT_ARGS,
  mapKey,
} from "./keymap.js";
import {
  buildFindElementsSelectors,
  buildSwipeCoords,
  type FindElementsCriteria,
} from "./wda-payloads.js";

export type { IosDevice } from "./types.js";

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

  /** True unless the device id belongs to a connected physical device. */
  private isSimulatorDevice(deviceId: string): boolean {
    try {
      return !listPhysicalDevices().some((d) => d.id === deviceId);
    } catch {
      return true;
    }
  }

  private async ensureWDA(deviceIdOverride?: string): Promise<WDAClient> {
    const effectiveId = deviceIdOverride ?? this.deviceId;

    if (!effectiveId) {
      const booted = this.getBootedDevices();
      if (booted.length === 0) {
        throw new Error("No booted iOS simulator found. Boot a simulator first.");
      }
      this.deviceId = booted[0].id;
      this.wdaClient = await this.wdaManager.ensureWDAReady(this.deviceId, true);
      return this.wdaClient;
    }

    // Per-call override: don't cache on instance if different from default
    if (deviceIdOverride && deviceIdOverride !== this.deviceId) {
      return this.wdaManager.ensureWDAReady(
        deviceIdOverride,
        this.isSimulatorDevice(deviceIdOverride)
      );
    }

    if (!this.wdaClient) {
      this.wdaClient = await this.wdaManager.ensureWDAReady(
        effectiveId,
        this.isSimulatorDevice(effectiveId)
      );
    }
    return this.wdaClient;
  }

  /** Thin instance wrapper around `execSimctl` (argv-form, no shell). */
  private execArgs(args: string[]): string {
    return execSimctl(args);
  }

  /** Thin instance wrapper around `execSimctlQuiet` (stderr suppressed). */
  private execArgsQuiet(args: string[]): string {
    return execSimctlQuiet(args);
  }

  /** Legacy string form: whitespace-split into argv tokens, then `execSimctl`. */
  private exec(command: string): string {
    return execSimctl(splitArgs(command));
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
   * Get list of iOS devices: simulators (simctl) plus connected physical
   * devices (go-ios). Physical discovery is best-effort — if go-ios is not
   * installed it contributes nothing and simulator behaviour is unchanged.
   */
  getDevices(): IosDevice[] {
    const simulators = parseDevicesJson(this.exec("list devices -j"));
    return [...simulators, ...listPhysicalDevices()];
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
   * Async screenshot that works for physical devices too: routes physical
   * devices through WDA `/screenshot` (simctl io only addresses simulators),
   * and simulators through the fast sync simctl path.
   */
  async screenshotRawAsync(deviceIdOverride?: string): Promise<Buffer> {
    const target = deviceIdOverride ?? this.deviceId;
    if (target && !this.isSimulatorDevice(target)) {
      const wdaClient = await this.ensureWDA(deviceIdOverride);
      return wdaClient.screenshot();
    }
    return this.screenshotRaw(deviceIdOverride);
  }

  /**
   * Tap at coordinates
   */
  async tap(x: number, y: number, deviceIdOverride?: string): Promise<void> {
    try {
      const wdaClient = await this.ensureWDA(deviceIdOverride);
      await wdaClient.tapByCoordinates(x, y);
    } catch (error: unknown) {
      throw wdaRequiredError("Tap", error);
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
      throw wdaRequiredError("Swipe", error);
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
      throw wdaRequiredError("Long press", error);
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

    const { x1, y1, x2, y2 } = buildSwipeCoords(direction, centerX, centerY, distance);
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
      throw wdaRequiredError("Text input", error);
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
    const mappedKey = mapKey(key);

    // Use simctl io for button presses
    if (mappedKey === "home") {
      this.execArgs(["io", this.targetDevice, "enumerate"]);
      // Trigger home button via keyboard shortcut
      execFileSync(
        "osascript",
        [...HOME_KEY_OSASCRIPT_ARGS],
        { encoding: "utf-8", timeout: SIMCTL_EXEC_TIMEOUT_MS }
      );
    } else {
      // Try generic approach
      execFileSync(
        "osascript",
        [...ACTIVATE_SIMULATOR_OSASCRIPT_ARGS],
        { encoding: "utf-8", timeout: SIMCTL_EXEC_TIMEOUT_MS }
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
      throw wdaRequiredError("WebDriverAgent", error);
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
  async findElements(criteria: FindElementsCriteria): Promise<Array<{ id: string; type: string; label: string; rect: WDARect }>> {
    const wdaClient = await this.ensureWDA();
    const elements: WDAElement[] = [];

    for (const sel of buildFindElementsSelectors(criteria)) {
      const found = await wdaClient.findElements(sel.using, sel.value);
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
    this.execArgs(["location", this.targetDevice, "set", formatLatLon(lat, lon)]);
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
    try {
      const output = this.execArgs(buildLogShowArgs(this.targetDevice, "5m", options));
      return options.lines ? sliceLastLines(output, options.lines) : output;
    } catch {
      // Fallback: try system log (last 1m, swallow stderr — replaces prior `2>/dev/null`).
      try {
        const fallback = this.execArgsQuiet(buildLogShowArgs(this.targetDevice, "1m"));
        return sliceLastLines(fallback, 100);
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
    try {
      const output = this.execArgs(buildAppLogArgs(this.targetDevice, bundleId));
      return sliceLastLines(output, lines);
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
