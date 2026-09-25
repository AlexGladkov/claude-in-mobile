import { execFileSync } from "child_process";
import { rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { MobileError } from "mcp-devices/errors";
import { validateDeviceId } from "mcp-devices/utils/sanitize";
import {
  makePrivateTempDir,
  readPrivateFileSync,
} from "mcp-devices/utils/private-storage";

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

const EXEC_TIMEOUT_MS = 30_000;
const MAX_SCREENSHOT_BYTES = 50 * 1024 * 1024;
const MAX_PULL_BYTES = 16 * 1024 * 1024;

export class AuroraClient {
  /**
   * SECURITY: All audb invocations route through this argv-form path (execFileSync — no /bin/sh -c).
   * Shell metacharacters in `args` are passed as literal argv slots, not parsed by the host shell.
   * This structurally prevents host-side OS Command Injection (CWE-78) — see issue #40.
   *
   * Mirrors the defense applied in src/adb/client.ts:75-97.
   */
  private runAudbSync(args: string[], deviceId?: string): string {
    if (deviceId !== undefined) {
      validateDeviceId(deviceId);
    }
    const commandArgs = deviceId === undefined
      ? args
      : ["-s", deviceId, ...args];
    try {
      const output = execFileSync("audb", commandArgs, {
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: EXEC_TIMEOUT_MS,
      });
      return output.trim();
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? Reflect.get(error, "code")
        : undefined;
      if (code === "ENOENT") {
        throw new Error("audb not found. Install: cargo install audb-client");
      }
      throw new MobileError(
        `audb ${args[0] ?? "unknown"} command failed.`,
        "AUDB_COMMAND_FAILED",
      );
  }
  }

  async checkAvailability(): Promise<boolean> {
    try {
      execFileSync("audb", ["--version"], {
        encoding: "utf-8",
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all configured Aurora devices
   * @returns Array of Device objects
   */
  listDevices(): Device[] {
    try {
      const output = this.runAudbSync(["device", "list"]);
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

  getActiveDevice(): string {
    const path = join(homedir(), ".config", "audb", "current_device");
    let selected: string;
    try {
      selected = readPrivateFileSync(path, 4096, "active Aurora device").toString("utf8").trim();
    } catch {
      throw new Error("Failed to read the active Aurora device.");
    }
    validateDeviceId(selected);
    return selected;
  }

  selectDevice(deviceId: string): void {
    validateDeviceId(deviceId);
    this.runAudbSync(["select", deviceId]);
  }

  /**
   * Performs a tap at the specified coordinates.
   * @param x - X coordinate in pixels
   * @param y - Y coordinate in pixels
   */
  tap(x: number, y: number, deviceId?: string): void {
    this.runAudbSync(["tap", String(x), String(y)], deviceId);
  }

  /**
   * Performs a long press at the specified coordinates.
   * @param x - X coordinate in pixels
   * @param y - Y coordinate in pixels
   * @param duration - Duration of the press in milliseconds
   */
  longPress(x: number, y: number, duration: number, deviceId?: string): void {
    this.runAudbSync(["tap", String(x), String(y), "--duration", String(duration)], deviceId);
  }

  /**
   * Performs a swipe in the specified direction.
   * @param direction - Direction to swipe: "up", "down", "left", or "right"
   */
  swipeDirection(direction: "up"|"down"|"left"|"right", deviceId?: string): void {
    this.runAudbSync(["swipe", direction], deviceId);
  }

  /**
   * Performs a swipe from one coordinate to another.
   * @param x1 - Starting X coordinate in pixels
   * @param y1 - Starting Y coordinate in pixels
   * @param x2 - Ending X coordinate in pixels
   * @param y2 - Ending Y coordinate in pixels
   */
  swipeCoords(x1: number, y1: number, x2: number, y2: number, deviceId?: string): void {
    this.runAudbSync(["swipe", String(x1), String(y1), String(x2), String(y2)], deviceId);
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
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number, deviceId?: string): void {
    this.runAudbSync(["swipe", String(x1), String(y1), String(x2), String(y2)], deviceId);
  }

  /** Input text on the selected Aurora device. */
  inputText(text: string, deviceId?: string): void {
    this.runAudbSync(["text", text], deviceId);
  }

  getUiHierarchy(_deviceId?: string): string {
    throw new MobileError(
      "Aurora UI hierarchy is not supported by audb.",
      "CAPABILITY_NOT_SUPPORTED",
    );
  }

  clearAppData(_packageName: string, _deviceId?: string): void {
    throw new MobileError(
      "Aurora app-data clearing is not supported by audb.",
      "CAPABILITY_NOT_SUPPORTED",
    );
  }

  /**
   * Sends a keyboard key event to the device.
   * @param key - Key name to send (e.g., "Enter", "Back", "Home")
   */
  pressKey(key: string, deviceId?: string): void {
    this.runAudbSync(["key", key], deviceId);
  }

  /**
   * Take screenshot and return raw PNG buffer (consistent with Android/iOS)
   * @returns Raw PNG buffer
   */
  screenshotRaw(deviceId?: string): Buffer {
    const tempDir = makePrivateTempDir("aurora-screenshot");
    const tmpFile = join(tempDir, "screenshot.png");

    try {
      // tmpFile passes as a literal argv slot — host shell never parses it,
      // so embedded metacharacters (if any future change introduced them) are inert.
      this.runAudbSync(["screenshot", "--output", tmpFile], deviceId);
      return readPrivateFileSync(tmpFile, MAX_SCREENSHOT_BYTES, "Aurora screenshot");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Takes a screenshot of the Aurora device
   * @returns Base64 encoded PNG screenshot
   */
  screenshot(deviceId?: string): string {
    return this.screenshotRaw(deviceId).toString("base64");
  }

  /**
   * Launch an application on the Aurora device
   * @param packageName - Application name (D-Bus format: ru.domain.AppName)
   * @returns Output message from audb
   */
  launchApp(packageName: string, deviceId?: string): string {
    const output = this.runAudbSync(["launch", packageName], deviceId);
    return output || `Launched ${packageName}`;
  }

  /**
   * Stop a running application
   * @param packageName - Application name (D-Bus format: ru.domain.AppName)
   */
  stopApp(packageName: string, deviceId?: string): void {
    this.runAudbSync(["stop", packageName], deviceId);
  }

  /**
   * Install an RPM package on the Aurora device
   * @param path - Local path to the RPM file
   * @returns Installation result message
   */
  installApp(path: string, deviceId?: string): string {
    const output = this.runAudbSync(["package", "install", path], deviceId);
    return output || `Installed ${path}`;
  }

  /**
   * Uninstall a package from the Aurora device
   * @param packageName - Package name (e.g., ru.domain.AppName)
   * @returns Uninstallation result message
   */
  uninstallApp(packageName: string, deviceId?: string): string {
    const output = this.runAudbSync(["package", "uninstall", packageName], deviceId);
    return output || `Uninstalled ${packageName}`;
  }

  /**
   * List installed packages on the Aurora device
   * @returns Array of package names
   */
  listPackages(deviceId?: string): string[] {
    const output = this.runAudbSync(["package", "list"], deviceId);
    if (!output) return [];
    return output.split("\n").filter(line => line.trim().length > 0);
  }

  /**
   * Execute a shell command on the Aurora device.
   *
   * SECURITY: `command` travels as a SINGLE argv slot (`audb shell <command>`) — the host
   * shell never parses it, so host-side metacharacters (`;`, `&&`, backticks, `$()`)
   * cannot inject host-side commands. This structurally closes CWE-78 on the host (issue #40).
   *
   * NOTE on device-side semantics: `command` may still be parsed by the DEVICE shell once
   * audb hands it off. Call sites that accept untrusted input MUST validate via
   * `validateShellCommand` from src/utils/sanitize.ts (system_shell tool already does this).
   *
   * @param command - Shell command to execute (already validated at call site)
   * @returns Command output
   */
  shell(command: string, deviceId?: string): string {
    return this.runAudbSync(["shell", command], deviceId);
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
  getLogs(options: LogOptions = {}, deviceId?: string): string {
    const args: string[] = ["logs"];
    if (options.lines) args.push("-n", String(Math.trunc(options.lines)));
    if (options.priority) args.push("--priority", options.priority);
    if (options.unit) args.push("--unit", options.unit);
    if (options.grep) args.push("--grep", options.grep);
    if (options.since) args.push("--since", options.since);

    return this.runAudbSync(args, deviceId);
  }

  /**
   * Clear device logs
   * @returns Result message
   */
  clearLogs(deviceId?: string): string {
    return this.runAudbSync(["logs", "--clear", "--force"], deviceId);
  }

  /**
   * Get detailed system information
   * @returns System info output
   */
  getSystemInfo(deviceId?: string): string {
    return this.runAudbSync(["info"], deviceId);
  }

  /**
   * Upload a file to the Aurora device
   * @param localPath - Path to the local file
   * @param remotePath - Destination path on the device
   * @returns Upload result message
   */
  pushFile(localPath: string, remotePath: string, deviceId?: string): string {
    const output = this.runAudbSync(["push", localPath, remotePath], deviceId);
    return output || `Uploaded ${localPath} → ${remotePath}`;
  }

  /**
   * Download a file from the Aurora device
   * @param remotePath - Path to the remote file
   * @param localPath - Optional local destination path (defaults to remote filename)
   * @returns File contents as Buffer
   */
  pullFile(remotePath: string, localPath?: string, deviceId?: string): Buffer {
    const local = localPath || remotePath.split("/").pop() || "pulled_file";
    this.runAudbSync(["pull", remotePath, "--output", local], deviceId);
    return readPrivateFileSync(local, MAX_PULL_BYTES, "Aurora pulled file");
  }
}

export const auroraClient = new AuroraClient();
