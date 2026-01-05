import { execSync, exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

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
      throw new Error(`ADB command failed: ${fullCommand}\n${error.message}`);
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
      throw new Error(`ADB command failed: ${fullCommand}\n${error.message}`);
    }
  }

  /**
   * Execute ADB command async
   */
  async execAsync(command: string): Promise<string> {
    const fullCommand = `adb ${this.deviceFlag} ${command}`;
    const { stdout } = await execAsync(fullCommand, {
      maxBuffer: 50 * 1024 * 1024
    });
    return stdout.trim();
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
   * Take screenshot and return as base64
   */
  screenshot(): string {
    const buffer = this.execRaw("exec-out screencap -p");
    return buffer.toString("base64");
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
   * Get UI hierarchy XML
   */
  getUiHierarchy(): string {
    this.exec("shell uiautomator dump /sdcard/ui.xml");
    return this.exec("shell cat /sdcard/ui.xml");
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
    const output = this.exec("shell dumpsys activity activities | grep mResumedActivity");
    const match = output.match(/(\S+\/\S+)/);
    return match?.[1] ?? "unknown";
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
}
