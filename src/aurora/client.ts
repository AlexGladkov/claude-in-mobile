import { exec, execSync } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import { readFileSync, unlinkSync } from "fs";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { compressScreenshot } from "../utils/image.js";

const execAsync = promisify(exec);

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

export class AuroraClient {
  private escapeShellArg(arg: string): string {
    return arg
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
  }

  private async runCommand(command: string): Promise<string> {
    try {
      const { stdout, stderr } = await execAsync(command);
      if (stderr && stderr.trim()) {
        if (stderr.includes("No device selected")) {
          throw new Error(
            "No Aurora device selected. Run:\n" +
            "  1. audb device list\n" +
            "  2. audb select <device>"
          );
        }
        console.warn(`[Aurora] Command produced stderr: ${stderr}`);
      }
      return stdout.trim();
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.message.includes("audb: command not found")) {
          throw new Error("audb not found. Install: cargo install audb-client");
        }
        throw new Error(`Command '${command}' failed: ${error.message}`);
      }
      throw new Error(`Command '${command}' failed with unknown error`);
    }
  }

  async checkAvailability(): Promise<boolean> {
    try {
      await execAsync("audb --version");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all configured Aurora devices
   * @returns Array of Device objects
   */
  async listDevices(): Promise<Device[]> {
    try {
      const output = await this.runCommand("audb device list");
      const devices: Device[] = [];

      // Strip ANSI escape codes
      const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, '');

      const lines = cleanOutput.split("\n");
      for (const line of lines) {
        // Skip headers, separators, and empty lines
        if (!line.trim() || line.includes("---") || line.includes("Index")) continue;

        // Parse format: "0     R570                 192.168.2.13       22     aurora-arm connected(3609s) *"
        const match = line.match(/^\s*\d+\s+(\S+)\s+([\d.]+)\s+\d+\s+(?:\S+)\s+(.+?)\s*(?:\*)?$/);
        if (match) {
          const [, name, host, status] = match;
          const isConnected = status.includes("connected");
          devices.push({
            id: host,
            name: name.trim(),
            platform: "aurora",
            state: isConnected ? "connected" : "disconnected",
            isSimulator: false,
            host,
          });
        }
      }

      return devices;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Aurora] Failed to list devices: ${errorMessage}`);
      // Return empty array on error (e.g., audb not installed)
      return [];
    }
  }

  /**
   * Synchronous version of listDevices using execSync
   * List all configured Aurora devices
   * @returns Array of Device objects
   */
  listDevicesSync(): Device[] {
    try {
      const output = execSync("audb device list", { encoding: "utf-8" });
      const devices: Device[] = [];

      // Strip ANSI escape codes
      const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, '');

      const lines = cleanOutput.split("\n");
      for (const line of lines) {
        // Skip headers, separators, and empty lines
        if (!line.trim() || line.includes("---") || line.includes("Index")) continue;

        // Parse format: "0     R570                 192.168.2.13       22     aurora-arm connected(3609s) *"
        const match = line.match(/^\s*\d+\s+(\S+)\s+([\d.]+)\s+\d+\s+(?:\S+)\s+(.+?)\s*(?:\*)?$/);
        if (match) {
          const [, name, host, status] = match;
          const isConnected = status.includes("connected");
          devices.push({
            id: host,
            name: name.trim(),
            platform: "aurora",
            state: isConnected ? "connected" : "disconnected",
            isSimulator: false,
            host,
          });
        }
      }

      return devices;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[Aurora] Failed to list devices (sync): ${errorMessage}`);
      // Return empty array on error (e.g., audb not installed)
      return [];
    }
  }

  async getActiveDevice(): Promise<string> {
    const path = `${process.env.HOME}/.config/audb/current_device`;
    try {
      return await fs.readFile(path, "utf-8");
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error) {
        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode === 'ENOENT') {
          throw new Error("No device selected");
        }
      }
      throw new Error(`Failed to read active device from ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Performs a tap at the specified coordinates.
   * @param x - X coordinate in pixels
   * @param y - Y coordinate in pixels
   */
  async tap(x: number, y: number): Promise<void> {
    await this.runCommand(`audb tap ${x} ${y}`);
  }

  /**
   * Performs a long press at the specified coordinates.
   * @param x - X coordinate in pixels
   * @param y - Y coordinate in pixels
   * @param duration - Duration of the press in milliseconds
   */
  async longPress(x: number, y: number, duration: number): Promise<void> {
    await this.runCommand(`audb tap ${x} ${y} --duration ${duration}`);
  }

  /**
   * Performs a swipe in the specified direction.
   * @param direction - Direction to swipe: "up", "down", "left", or "right"
   */
  async swipeDirection(direction: "up"|"down"|"left"|"right"): Promise<void> {
    await this.runCommand(`audb swipe ${direction}`);
  }

  /**
   * Performs a swipe from one coordinate to another.
   * @param x1 - Starting X coordinate in pixels
   * @param y1 - Starting Y coordinate in pixels
   * @param x2 - Ending X coordinate in pixels
   * @param y2 - Ending Y coordinate in pixels
   */
  async swipeCoords(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    await this.runCommand(`audb swipe ${x1} ${y1} ${x2} ${y2}`);
  }

  /**
   * Performs a swipe from one coordinate to another.
   * Compatible with AdbClient signature.
   * @param x1 - Starting X coordinate
   * @param y1 - Starting Y coordinate
   * @param x2 - Ending X coordinate
   * @param y2 - Ending Y coordinate
   * @param durationMs - Duration in milliseconds (ignored by audb, kept for compatibility)
   */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<void> {
    await this.runCommand(`audb swipe ${x1} ${y1} ${x2} ${y2}`);
  }

  /**
   * Input text on Aurora device.
   * @unimplemented - audb doesn't have direct text input support yet
   * @todo Implement via clipboard or D-Bus when available
   */
  async inputText(text: string): Promise<void> {
    console.warn(`[Aurora] inputText not implemented: "${text}"`);
    // Placeholder - return silently or implement via clipboard in future
  }

  /**
   * Get UI hierarchy from Aurora device.
   * @unimplemented - UI scraping not available via audb yet
   * @todo Implement when audb adds UI dump support
   */
  async getUiHierarchy(): Promise<string> {
    console.warn("[Aurora] getUiHierarchy not implemented");
    return "<hierarchy><note>Aurora UI hierarchy not yet available via audb</note></hierarchy>";
  }

  /**
   * Clear app data on Aurora device.
   * @unimplemented - audb doesn't have this command yet
   */
  async clearAppData(packageName: string): Promise<void> {
    console.warn(`[Aurora] clearAppData not implemented for ${packageName}`);
  }

  /**
   * Sends a keyboard key event to the device.
   * @param key - Key name to send (e.g., "Enter", "Back", "Home")
   */
  async pressKey(key: string): Promise<void> {
    await this.runCommand(`audb key ${key}`);
  }

  /**
   * Take screenshot and return raw PNG buffer (consistent with Android/iOS)
   * @returns Raw PNG buffer
   */
  screenshotRaw(): Buffer {
    const uniqueId = randomBytes(8).toString("hex");
    const tmpFile = `${tmpdir()}/aurora_screenshot_${uniqueId}.png`;

    try {
      execSync(`audb screenshot --output "${tmpFile}"`);
      return readFileSync(tmpFile);
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }

  /**
   * Takes a screenshot of the Aurora device
   * @param options - Screenshot options (compression, size, quality)
   * @returns Screenshot result with base64 data and MIME type
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const buffer = this.screenshotRaw();

    if (options.compress !== false) {
      return compressScreenshot(buffer, {
        maxWidth: options.maxWidth,
        maxHeight: options.maxHeight,
        quality: options.quality,
      });
    }

    return {
      data: buffer.toString("base64"),
      mimeType: "image/png",
    };
  }

  /**
   * Launch an application on the Aurora device
   * @param packageName - Application name (D-Bus format: ru.domain.AppName)
   * @returns Output message from audb
   */
  async launchApp(packageName: string): Promise<string> {
    const output = await this.runCommand(`audb launch ${packageName}`);
    return output || `Launched ${packageName}`;
  }

  /**
   * Stop a running application
   * @param packageName - Application name (D-Bus format: ru.domain.AppName)
   * @returns Promise that resolves when the app is stopped
   */
  async stopApp(packageName: string): Promise<void> {
    await this.runCommand(`audb stop ${packageName}`);
  }

  /**
   * Install an RPM package on the Aurora device
   * @param path - Local path to the RPM file
   * @returns Installation result message
   */
  async installApp(path: string): Promise<string> {
    const output = await this.runCommand(`audb package install ${path}`);
    return output || `Installed ${path}`;
  }

  /**
   * Uninstall a package from the Aurora device
   * @param packageName - Package name (e.g., ru.domain.AppName)
   * @returns Uninstallation result message
   */
  async uninstallApp(packageName: string): Promise<string> {
    const output = await this.runCommand(`audb package uninstall ${packageName}`);
    return output || `Uninstalled ${packageName}`;
  }

  /**
   * List installed packages on the Aurora device
   * @returns Array of package names
   */
  async listPackages(): Promise<string[]> {
    const output = await this.runCommand("audb package list");
    if (!output) return [];
    return output.split("\n").filter(line => line.trim().length > 0);
  }

  /**
   * Execute a shell command on the Aurora device
   *
   * WARNING: This method executes arbitrary commands on the device.
   * Input validation should be performed at the call site.
   *
   * @param command - Shell command to execute (must be validated/sanitized)
   * @returns Command output
   */
  async shell(command: string): Promise<string> {
    const escaped = this.escapeShellArg(command);
    return await this.runCommand(`audb shell ${escaped}`);
  }

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
  async getLogs(options: LogOptions = {}): Promise<string> {
    let cmd = "audb logs";
    if (options.lines) cmd += ` -n ${options.lines}`;
    if (options.priority) cmd += ` --priority ${options.priority}`;
    if (options.unit) cmd += ` --unit ${options.unit}`;
    if (options.grep) {
      const escaped = options.grep.replace(/'/g, "'\\''");
      cmd += ` --grep '${escaped}'`;
    }
    if (options.since) {
      const escaped = options.since.replace(/'/g, "'\\''");
      cmd += ` --since '${escaped}'`;
    }

    return await this.runCommand(cmd);
  }

  /**
   * Clear device logs
   * @returns Result message
   */
  async clearLogs(): Promise<string> {
    return await this.runCommand("audb logs --clear --force");
  }

  /**
   * Get detailed system information
   * @returns System info output
   */
  async getSystemInfo(): Promise<string> {
    return await this.runCommand("audb info");
  }

  /**
   * Upload a file to the Aurora device
   * @param localPath - Path to the local file
   * @param remotePath - Destination path on the device
   * @returns Upload result message
   */
  async pushFile(localPath: string, remotePath: string): Promise<string> {
    const output = await this.runCommand(`audb push ${localPath} ${remotePath}`);
    return output || `Uploaded ${localPath} → ${remotePath}`;
  }

  /**
   * Download a file from the Aurora device
   * @param remotePath - Path to the remote file
   * @param localPath - Optional local destination path (defaults to remote filename)
   * @returns File contents as Buffer
   */
  async pullFile(remotePath: string, localPath?: string): Promise<Buffer> {
    const local = localPath || remotePath.split("/").pop() || "pulled_file";
    await this.runCommand(`audb pull ${remotePath} --output "${local}"`);
    return await fs.readFile(local);
  }
}

export const auroraClient = new AuroraClient();

