import { execSync, exec, execFile } from "child_process";
import { promisify } from "util";
import { classifyAdbError } from "../errors.js";

const execAsyncCmd = promisify(exec);
const execFileAsync = promisify(execFile);

export interface Device {
  id: string;
  state: string;
  model?: string;
}

export class AdbClient {
  private deviceId?: string;

  constructor(deviceId?: string) {
    this.deviceId = deviceId;
  }

  private get deviceFlag(): string {
    return this.deviceId ? `-s ${this.deviceId}` : "";
  }

  /**
   * Execute ADB command and return stdout as string
   */
  exec(command: string): string {
    const fullCommand = `adb ${this.deviceFlag} ${command}`;
    try {
      return execSync(fullCommand, {
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024 // 50MB for screenshots
      }).trim();
    } catch (error: any) {
      throw classifyAdbError(error.stderr?.toString() ?? error.message, fullCommand);
    }
  }

  /**
   * Execute ADB command and return raw bytes (for screenshots)
   */
  execRaw(command: string): Buffer {
    const fullCommand = `adb ${this.deviceFlag} ${command}`;
    try {
      return execSync(fullCommand, {
        maxBuffer: 50 * 1024 * 1024
      });
    } catch (error: any) {
      throw classifyAdbError(error.stderr?.toString() ?? error.message, fullCommand);
    }
  }

  /**
   * Execute ADB command async (non-blocking)
   */
  async execAsync(command: string): Promise<string> {
    const fullCommand = `adb ${this.deviceFlag} ${command}`;
    try {
      const { stdout } = await execAsyncCmd(fullCommand, {
        maxBuffer: 50 * 1024 * 1024
      });
      return stdout.trim();
    } catch (error: any) {
      throw classifyAdbError(error.stderr?.toString() ?? error.message, fullCommand);
    }
  }

  /**
   * Execute ADB command async and return raw bytes (for screenshots)
   */
  async execRawAsync(command: string): Promise<Buffer> {
    const args = this.deviceId
      ? ["-s", this.deviceId, ...command.split(/\s+/)]
      : command.split(/\s+/);
    try {
      const { stdout } = await execFileAsync("adb", args, {
        maxBuffer: 50 * 1024 * 1024,
        encoding: "buffer" as any,
      });
      return stdout as unknown as Buffer;
    } catch (error: any) {
      throw classifyAdbError(error.stderr?.toString() ?? error.message, `adb ${args.join(" ")}`);
    }
  }

  /**
   * Get list of connected devices
   */
  getDevices(): Device[] {
    const output = execSync("adb devices -l", { encoding: "utf-8" });
    const lines = output.split("\n").slice(1); // Skip header

    return lines
      .filter(line => line.trim())
      .map(line => {
        const parts = line.split(/\s+/);
        const id = parts[0];
        const state = parts[1];
        const modelMatch = line.match(/model:(\S+)/);

        return {
          id,
          state,
          model: modelMatch?.[1]
        };
      });
  }

  /**
   * Set active device
   */
  setDevice(deviceId: string): void {
    this.deviceId = deviceId;
  }

  /**
   * Take screenshot and return raw PNG buffer
   */
  screenshotRaw(): Buffer {
    return this.execRaw("exec-out screencap -p");
  }

  /**
   * Take screenshot async (non-blocking)
   */
  async screenshotRawAsync(): Promise<Buffer> {
    return this.execRawAsync("exec-out screencap -p");
  }

  /**
   * Take screenshot and return as base64 PNG (legacy)
   */
  screenshot(): string {
    return this.screenshotRaw().toString("base64");
  }

  /**
   * Tap at coordinates
   */
  tap(x: number, y: number): void {
    this.exec(`shell input tap ${x} ${y}`);
  }

  /**
   * Long press at coordinates
   */
  longPress(x: number, y: number, durationMs: number = 1000): void {
    this.exec(`shell input swipe ${x} ${y} ${x} ${y} ${durationMs}`);
  }

  /**
   * Swipe gesture
   */
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number = 300): void {
    this.exec(`shell input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);
  }

  /**
   * Swipe in direction (uses screen center)
   */
  swipeDirection(direction: "up" | "down" | "left" | "right", distance: number = 800): void {
    // Get screen size
    const sizeOutput = this.exec("shell wm size");
    const match = sizeOutput.match(/(\d+)x(\d+)/);
    const width = match ? parseInt(match[1]) : 1080;
    const height = match ? parseInt(match[2]) : 1920;

    const centerX = Math.floor(width / 2);
    const centerY = Math.floor(height / 2);

    const coords = {
      up: [centerX, centerY + distance/2, centerX, centerY - distance/2],
      down: [centerX, centerY - distance/2, centerX, centerY + distance/2],
      left: [centerX + distance/2, centerY, centerX - distance/2, centerY],
      right: [centerX - distance/2, centerY, centerX + distance/2, centerY],
    };

    const [x1, y1, x2, y2] = coords[direction];
    this.swipe(x1, y1, x2, y2);
  }

  /**
   * Input text
   */
  inputText(text: string): void {
    // Escape special characters for shell
    const escaped = text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/'/g, "\\'")
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$")
      .replace(/ /g, "%s")
      .replace(/&/g, "\\&")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/</g, "\\<")
      .replace(/>/g, "\\>")
      .replace(/\|/g, "\\|")
      .replace(/;/g, "\\;");

    this.exec(`shell input text "${escaped}"`);
  }

  /**
   * Press key by name or keycode
   */
  pressKey(key: string): void {
    const keyCodes: Record<string, number> = {
      "BACK": 4,
      "HOME": 3,
      "MENU": 82,
      "ENTER": 66,
      "TAB": 61,
      "DELETE": 67,
      "BACKSPACE": 67,
      "POWER": 26,
      "VOLUME_UP": 24,
      "VOLUME_DOWN": 25,
      "VOLUME_MUTE": 164,
      "CAMERA": 27,
      "APP_SWITCH": 187,
      "DPAD_UP": 19,
      "DPAD_DOWN": 20,
      "DPAD_LEFT": 21,
      "DPAD_RIGHT": 22,
      "DPAD_CENTER": 23,
      "SEARCH": 84,
      "ESCAPE": 111,
      "SPACE": 62,
    };

    const keyCode = keyCodes[key.toUpperCase()] ?? parseInt(key);
    if (isNaN(keyCode)) {
      throw new Error(`Unknown key: ${key}`);
    }

    this.exec(`shell input keyevent ${keyCode}`);
  }

  /**
   * Get UI hierarchy XML (sync — blocks event loop)
   */
  getUiHierarchy(): string {
    this.exec("shell uiautomator dump /sdcard/ui.xml");
    return this.exec("shell cat /sdcard/ui.xml");
  }

  /**
   * Get UI hierarchy XML async (non-blocking)
   */
  async getUiHierarchyAsync(): Promise<string> {
    await this.execAsync("shell uiautomator dump /sdcard/ui.xml");
    return this.execAsync("shell cat /sdcard/ui.xml");
  }

  /**
   * Launch app by package name
   */
  launchApp(packageName: string): string {
    // Try to get launch activity
    try {
      const output = this.exec(`shell cmd package resolve-activity --brief ${packageName}`);
      const activity = output.split("\n").find(line => line.includes("/"));

      if (activity) {
        this.exec(`shell am start -n ${activity.trim()}`);
        return `Launched ${activity.trim()}`;
      }
    } catch {
      // Fallback: use monkey to launch
    }

    this.exec(`shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
    return `Launched ${packageName}`;
  }

  /**
   * Stop app
   */
  stopApp(packageName: string): void {
    this.exec(`shell am force-stop ${packageName}`);
  }

  /**
   * Clear app data
   */
  clearAppData(packageName: string): void {
    this.exec(`shell pm clear ${packageName}`);
  }

  /**
   * Grant runtime permission to app
   */
  grantPermission(packageName: string, permission: string): void {
    this.exec(`shell pm grant ${packageName} ${permission}`);
  }

  /**
   * Revoke runtime permission from app
   */
  revokePermission(packageName: string, permission: string): void {
    this.exec(`shell pm revoke ${packageName} ${permission}`);
  }

  /**
   * Reset all permissions for app (clears app data)
   */
  resetPermissions(packageName: string): void {
    this.exec(`shell pm reset-permissions ${packageName}`);
  }

  /**
   * Install APK
   */
  installApk(apkPath: string): string {
    return this.exec(`install -r "${apkPath}"`);
  }

  /**
   * Uninstall app
   */
  uninstallApp(packageName: string): string {
    return this.exec(`uninstall ${packageName}`);
  }

  /**
   * Get current activity
   */
  getCurrentActivity(): string {
    try {
      // Get focused activity (works on most Android versions)
      const output = this.exec("shell dumpsys activity activities");

      // Try different patterns for different Android versions
      const patterns = [
        /mResumedActivity[^}]*?(\S+\/\.\S+)/,           // Android 10+
        /mResumedActivity[^}]*?(\S+\/\S+)/,             // Generic
        /resumedActivity[^}]*?(\S+\/\S+)/,              // Some versions
        /topResumedActivity[^}]*?(\S+\/\S+)/,           // Android 12+
        /mFocusedActivity[^}]*?(\S+\/\S+)/,             // Older Android
        /ResumedActivity[^}]*?(\S+\/\S+)/i,             // Case-insensitive fallback
      ];

      for (const pattern of patterns) {
        const match = output.match(pattern);
        if (match?.[1]) {
          return match[1];
        }
      }

      // Fallback: try getting current focus from window manager
      const wmOutput = this.exec("shell dumpsys window windows");
      const focusMatch = wmOutput.match(/mCurrentFocus[^}]*?(\S+\/\S+)/);
      if (focusMatch?.[1]) {
        return focusMatch[1];
      }

      return "unknown";
    } catch (error: any) {
      // Try alternative method
      try {
        const output = this.exec("shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'");
        const match = output.match(/(\S+\/\S+)/);
        return match?.[1] ?? "unknown";
      } catch {
        return "unknown (could not determine)";
      }
    }
  }

  /**
   * Get screen size
   */
  getScreenSize(): { width: number; height: number } {
    const output = this.exec("shell wm size");
    const match = output.match(/(\d+)x(\d+)/);
    return {
      width: match ? parseInt(match[1]) : 1080,
      height: match ? parseInt(match[2]) : 1920
    };
  }

  /**
   * Wait for device
   */
  waitForDevice(): void {
    this.exec("wait-for-device");
  }

  /**
   * Execute shell command
   */
  shell(command: string): string {
    return this.exec(`shell ${command}`);
  }

  /**
   * Get device logs (logcat)
   * @param options - filter options
   */
  getLogs(options: {
    tag?: string;
    level?: "V" | "D" | "I" | "W" | "E" | "F";
    lines?: number;
    since?: string;
    package?: string;
  } = {}): string {
    let cmd = "logcat -d";

    // Filter by log level
    if (options.level) {
      cmd += ` *:${options.level}`;
    }

    // Filter by tag
    if (options.tag) {
      cmd += ` -s ${options.tag}`;
    }

    // Limit number of lines
    if (options.lines) {
      cmd += ` -t ${options.lines}`;
    }

    // Filter by time (e.g., "01-01 00:00:00.000")
    if (options.since) {
      cmd += ` -t "${options.since}"`;
    }

    const output = this.exec(`shell ${cmd}`);

    // Filter by package if specified
    if (options.package) {
      const lines = output.split("\n");
      const filtered = lines.filter(line =>
        line.includes(options.package!) ||
        line.match(/^\d+-\d+\s+\d+:\d+/) // Keep timestamp lines
      );
      return filtered.join("\n");
    }

    return output;
  }

  /**
   * Clear logcat buffer
   */
  clearLogs(): void {
    this.exec("logcat -c");
  }

  /**
   * Get network stats
   */
  getNetworkStats(): string {
    return this.exec("shell dumpsys netstats | head -100");
  }

  /**
   * Get battery info
   */
  getBatteryInfo(): string {
    return this.exec("shell dumpsys battery");
  }

  /**
   * Get memory info
   */
  getMemoryInfo(packageName?: string): string {
    if (packageName) {
      return this.exec(`shell dumpsys meminfo ${packageName}`);
    }
    return this.exec("shell cat /proc/meminfo | head -20");
  }

  /**
   * Get CPU info
   */
  getCpuInfo(): string {
    return this.exec("shell top -n 1 | head -20");
  }
}
