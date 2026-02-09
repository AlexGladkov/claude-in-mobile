import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync, unlinkSync } from "fs";
import { WDAManager, WDAClient, WDAElement, WDARect } from "./wda/index.js";
import { classifySimctlError } from "../errors.js";

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
    this.deviceId = deviceId;
  }

  private async ensureWDA(): Promise<WDAClient> {
    if (!this.deviceId) {
      const booted = this.getBootedDevices();
      if (booted.length === 0) {
        throw new Error("No booted iOS simulator found. Boot a simulator first.");
      }
      this.deviceId = booted[0].id;
    }

    if (!this.wdaClient) {
      this.wdaClient = await this.wdaManager.ensureWDAReady(this.deviceId);
    }
    return this.wdaClient;
  }

  /**
   * Execute simctl command
   */
  private exec(command: string): string {
    const fullCommand = `xcrun simctl ${command}`;
    try {
      return execSync(fullCommand, {
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024
      }).trim();
    } catch (error: any) {
      throw classifySimctlError(error.stderr?.toString() ?? error.message, fullCommand);
    }
  }

  /**
   * Get the active device ID or 'booted'
   */
  private get targetDevice(): string {
    return this.deviceId ?? "booted";
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

      for (const device of deviceList as any[]) {
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
    this.deviceId = deviceId;
  }

  /**
   * Boot simulator
   */
  boot(deviceId?: string): void {
    const target = deviceId ?? this.deviceId;
    if (!target) throw new Error("No device specified");
    this.exec(`boot ${target}`);
  }

  /**
   * Shutdown simulator
   */
  shutdown(deviceId?: string): void {
    const target = deviceId ?? this.deviceId ?? "booted";
    this.exec(`shutdown ${target}`);
  }

  /**
   * Take screenshot and return raw PNG buffer
   */
  screenshotRaw(): Buffer {
    const tmpFile = join(tmpdir(), `ios-screenshot-${Date.now()}.png`);
    try {
      this.exec(`io ${this.targetDevice} screenshot "${tmpFile}"`);
      return readFileSync(tmpFile);
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  /**
   * Take screenshot and return as base64 (legacy)
   */
  screenshot(): string {
    return this.screenshotRaw().toString("base64");
  }

  /**
   * Tap at coordinates
   */
  async tap(x: number, y: number): Promise<void> {
    try {
      const wdaClient = await this.ensureWDA();
      await wdaClient.tapByCoordinates(x, y);
    } catch (error: any) {
      throw new Error(
        `Tap requires WebDriverAgent.\n\n` +
        `Install: npm install -g appium && appium driver install xcuitest\n` +
        `Or set WDA_PATH environment variable.\n\n` +
        `Error: ${error.message}`
      );
    }
  }

  /**
   * Swipe gesture
   */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number = 300): Promise<void> {
    try {
      const wdaClient = await this.ensureWDA();
      await wdaClient.swipe(x1, y1, x2, y2, durationMs);
    } catch (error: any) {
      throw new Error(
        `Swipe requires WebDriverAgent.\n\n` +
        `Install: npm install -g appium && appium driver install xcuitest\n` +
        `Or set WDA_PATH environment variable.\n\n` +
        `Error: ${error.message}`
      );
    }
  }

  /**
   * Long press at coordinates via WDA Actions API
   */
  async longPress(x: number, y: number, durationMs: number = 1000): Promise<void> {
    try {
      const wdaClient = await this.ensureWDA();
      await wdaClient.longPress(x, y, durationMs);
    } catch (error: any) {
      throw new Error(
        `Long press requires WebDriverAgent.\n\n` +
        `Install: npm install -g appium && appium driver install xcuitest\n` +
        `Or set WDA_PATH environment variable.\n\n` +
        `Error: ${error.message}`
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
   * Input text using simctl
   */
  inputText(text: string): void {
    // Escape for shell
    const escaped = text.replace(/'/g, "'\\''");
    this.exec(`io ${this.targetDevice} input text '${escaped}'`);
  }

  /**
   * Press key
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
      execSync(`xcrun simctl io ${this.targetDevice} enumerate`, { encoding: "utf-8" });
      // Trigger home button via keyboard shortcut
      execSync(`osascript -e 'tell application "Simulator" to activate' -e 'tell application "System Events" to keystroke "h" using {command down, shift down}'`, { encoding: "utf-8" });
    } else {
      // Try generic approach
      execSync(`osascript -e 'tell application "Simulator" to activate'`, { encoding: "utf-8" });
    }
  }

  /**
   * Launch app by bundle ID
   */
  launchApp(bundleId: string): string {
    this.exec(`launch ${this.targetDevice} ${bundleId}`);
    return `Launched ${bundleId}`;
  }

  /**
   * Terminate app
   */
  stopApp(bundleId: string): void {
    try {
      this.exec(`terminate ${this.targetDevice} ${bundleId}`);
    } catch {
      // App might not be running
    }
  }

  /**
   * Install app (.app bundle or .ipa)
   */
  installApp(path: string): string {
    this.exec(`install ${this.targetDevice} "${path}"`);
    return `Installed ${path}`;
  }

  /**
   * Uninstall app
   */
  uninstallApp(bundleId: string): string {
    this.exec(`uninstall ${this.targetDevice} ${bundleId}`);
    return `Uninstalled ${bundleId}`;
  }

  /**
   * Get UI hierarchy (limited on iOS simulator)
   * Returns accessibility info if available
   */
  async getUiHierarchy(): Promise<string> {
    try {
      const wdaClient = await this.ensureWDA();
      const tree = await wdaClient.getAccessibleSource();
      return JSON.stringify(tree, null, 2);
    } catch (error: any) {
      throw new Error(
        `WebDriverAgent required for iOS UI inspection.\n\n` +
        `Install: npm install -g appium && appium driver install xcuitest\n` +
        `Or set WDA_PATH environment variable.\n\n` +
        `Error: ${error.message}`
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
   * Tap element by element ID
   */
  async tapElement(elementId: string): Promise<void> {
    const wdaClient = await this.ensureWDA();
    await wdaClient.clickElement(elementId);
  }

  /**
   * Open URL in simulator
   */
  openUrl(url: string): void {
    this.exec(`openurl ${this.targetDevice} "${url}"`);
  }

  /**
   * Add photo to simulator
   */
  addPhoto(imagePath: string): void {
    this.exec(`addmedia ${this.targetDevice} "${imagePath}"`);
  }

  /**
   * Set location
   */
  setLocation(lat: number, lon: number): void {
    this.exec(`location ${this.targetDevice} set ${lat},${lon}`);
  }

  /**
   * Get device info
   */
  getDeviceInfo(): Record<string, string> {
    const output = this.exec(`getenv ${this.targetDevice} SIMULATOR_DEVICE_NAME`);
    return { name: output };
  }

  /**
   * Execute arbitrary simctl command
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
      let cmd = `spawn ${this.targetDevice} log show --style compact`;

      // Add time limit (last 5 minutes by default)
      cmd += " --last 5m";

      // Filter by level
      if (options.level) {
        cmd += ` --predicate 'messageType == ${options.level}'`;
      }

      // Custom predicate
      if (options.predicate) {
        cmd += ` --predicate '${options.predicate}'`;
      }

      const output = this.exec(cmd);

      // Limit lines if specified
      if (options.lines) {
        const lines = output.split("\n");
        return lines.slice(-options.lines).join("\n");
      }

      return output;
    } catch (error: any) {
      // Fallback: try system log
      try {
        return execSync(
          `xcrun simctl spawn ${this.targetDevice} log show --style compact --last 1m 2>/dev/null | tail -100`,
          { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
        );
      } catch {
        return "Unable to retrieve logs. Make sure the simulator is running.";
      }
    }
  }

  /**
   * Get app-specific logs
   */
  getAppLogs(bundleId: string, lines: number = 100): string {
    try {
      const cmd = `spawn ${this.targetDevice} log show --style compact --last 5m --predicate 'subsystem == "${bundleId}"' | tail -${lines}`;
      return this.exec(cmd);
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
    return this.exec(`privacy ${this.targetDevice} grant ${service} ${bundleId}`);
  }

  /**
   * Revoke privacy permission on iOS simulator
   */
  revokePermission(bundleId: string, service: string): string {
    return this.exec(`privacy ${this.targetDevice} revoke ${service} ${bundleId}`);
  }

  /**
   * Reset all privacy permissions for an app on iOS simulator
   */
  resetPermissions(bundleId: string): string {
    return this.exec(`privacy ${this.targetDevice} reset all ${bundleId}`);
  }
}
