import { execFileSync } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { randomBytes } from "crypto";
import { tmpdir } from "os";
import { MobileError } from "../errors.js";

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
  kernel?: boolean;
}

export interface AudbSuccess<T> {
  ok: true;
  deviceId: string;
  data: T;
}

export interface AudbFailure {
  ok: false;
  deviceId: string;
  error: { code: string; message: string };
  data?: unknown;
}

export type AudbEnvelope<T> = AudbSuccess<T> | AudbFailure;

export class AudbCommandError extends MobileError {
  constructor(
    code: string,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message, code);
    this.name = "AudbCommandError";
  }
}

export interface AuroraClientOptions {
  binaryPath?: string;
  defaultTimeoutMs?: number;
  /** Test-only escape hatch for command shims that do not implement --version. */
  skipVersionCheck?: boolean;
}

interface AudbDeviceRecord {
  id: string;
  name: string;
  state: string;
  kind: string;
  host?: string;
}

const EXEC_TIMEOUT_MS = 30_000;
const MIN_AUDB_VERSION = [0, 2, 0] as const;

function parseVersion(output: string): [number, number, number] | undefined {
  const match = output.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (actual[i] > minimum[i]) return true;
    if (actual[i] < minimum[i]) return false;
  }
  return true;
}

function stringifyData(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export class AuroraClient {
  private readonly binary: string;
  private readonly defaultTimeoutMs: number;
  private readonly skipVersionCheck: boolean;
  private versionChecked = false;
  private selectedDeviceId = "emulator";

  constructor(options: AuroraClientOptions = {}) {
    this.binary = options.binaryPath ?? process.env.AUDB_PATH ?? "audb";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? EXEC_TIMEOUT_MS;
    this.skipVersionCheck = options.skipVersionCheck ?? false;
  }

  private ensureVersion(): void {
    if (this.versionChecked || this.skipVersionCheck) return;
    let output: string;
    try {
      output = execFileSync(this.binary, ["--version"], {
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();
    } catch (error: unknown) {
      if (error instanceof Error && ((error as NodeJS.ErrnoException).code === "ENOENT" || error.message.includes("ENOENT"))) {
        throw new AudbCommandError(
          "AUDB_NOT_INSTALLED",
          "audb not found. Install: cargo install audb-client --version 0.2.0, or set AUDB_PATH.",
        );
      }
      throw new AudbCommandError("AUDB_VERSION_CHECK_FAILED", `Could not execute audb --version: ${error instanceof Error ? error.message : String(error)}`);
    }
    const version = parseVersion(output);
    if (!version || !versionAtLeast(version, MIN_AUDB_VERSION)) {
      throw new AudbCommandError(
        "AUDB_VERSION_UNSUPPORTED",
        `audb >= 0.2.0 is required (found: ${output || "unknown"}). Update with: cargo install audb-client --version 0.2.0 --force`,
      );
    }
    this.versionChecked = true;
  }

  private parseEnvelope<T>(raw: string, display: string): T {
    let envelope: AudbEnvelope<T>;
    try {
      envelope = JSON.parse(raw.trim()) as AudbEnvelope<T>;
    } catch {
      throw new AudbCommandError("AUDB_INVALID_RESPONSE", `Command '${display}' returned invalid JSON: ${raw.trim().slice(0, 500)}`);
    }
    if (!envelope || typeof envelope !== "object" || typeof envelope.ok !== "boolean") {
      throw new AudbCommandError("AUDB_INVALID_RESPONSE", `Command '${display}' returned an invalid audb envelope.`);
    }
    if (!envelope.ok) {
      throw new AudbCommandError(envelope.error?.code ?? "AUDB_ERROR", envelope.error?.message ?? `Command '${display}' failed`, envelope.data);
    }
    return envelope.data;
  }

  /** Execute a typed audb 0.2 command through its stable JSON automation contract. */
  execute<T = unknown>(args: string[], timeoutMs: number = this.defaultTimeoutMs): T {
    this.ensureVersion();
    const argv = ["--json", ...args];
    const display = `${this.binary} ${argv.join(" ")}`;
    try {
      const output = execFileSync(this.binary, argv, {
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
        timeout: timeoutMs,
      });
      return this.parseEnvelope<T>(output, display);
    } catch (error: unknown) {
      if (error instanceof AudbCommandError) throw error;
      const processError = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: string };
      const stdout = processError.stdout?.toString() ?? "";
      if (stdout.trim()) return this.parseEnvelope<T>(stdout, display);
      if (processError.code === "ENOENT" || processError.message?.includes("ENOENT")) {
        throw new AudbCommandError("AUDB_NOT_INSTALLED", "audb not found. Install: cargo install audb-client --version 0.2.0, or set AUDB_PATH.");
      }
      const stderr = processError.stderr?.toString().trim();
      throw new AudbCommandError("AUDB_EXEC_FAILED", `Command '${display}' failed: ${stderr || processError.message || String(error)}`);
    }
  }

  async checkAvailability(): Promise<boolean> {
    try {
      this.ensureVersion();
      return true;
    } catch {
      return false;
    }
  }

  listDevices(): Device[] {
    try {
      return this.execute<AudbDeviceRecord[]>(["device", "list"]).map((device) => ({
        id: device.id,
        name: device.name,
        platform: "aurora" as const,
        state: device.state === "online" ? "connected" : "disconnected",
        isSimulator: device.kind === "emulator",
        host: device.host,
      }));
    } catch (error: unknown) {
      console.error(`[Aurora] Failed to list devices: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  selectDevice(deviceId: string): void {
    this.execute(["select", deviceId]);
    this.selectedDeviceId = deviceId;
  }

  getActiveDevice(): string {
    const device = this.execute<AudbDeviceRecord>(["device", "current"]);
    this.selectedDeviceId = device.id;
    return device.id;
  }

  tap(x: number, y: number): void { this.execute(["tap", String(x), String(y)]); }
  longPress(x: number, y: number, duration: number): void {
    this.execute(["tap", String(x), String(y), "--duration", String(duration)]);
  }
  swipeDirection(direction: "up" | "down" | "left" | "right"): void {
    this.execute(["swipe", direction]);
  }
  swipeCoords(x1: number, y1: number, x2: number, y2: number, durationMs?: number): void {
    const args = ["swipe", String(x1), String(y1), String(x2), String(y2)];
    if (durationMs !== undefined) args.push("--duration", String(durationMs));
    this.execute(args);
  }
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): void {
    this.swipeCoords(x1, y1, x2, y2, durationMs);
  }
  inputText(text: string): void { this.execute(["text", text]); }
  pressKey(key: string): void { this.execute(["key", key]); }

  getUiHierarchy(): never {
    throw new AudbCommandError("CAPABILITY_UNAVAILABLE", "Aurora UI accessibility hierarchy is not available without an application-side helper.");
  }

  clearAppData(packageName: string, confirm = false): unknown {
    return this.execute(["app", "clear-data", packageName, confirm ? "--confirm" : "--dry-run"]);
  }

  screenshotRaw(): Buffer {
    const uniqueId = randomBytes(8).toString("hex");
    const tmpFile = `${tmpdir()}/aurora_screenshot_${uniqueId}.png`;
    try {
      this.execute(["screenshot", "--output", tmpFile]);
      return readFileSync(tmpFile);
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  }
  screenshot(): string { return this.screenshotRaw().toString("base64"); }

  launchApp(packageName: string): string { return stringifyData(this.execute(["app", "launch", packageName])); }
  stopApp(packageName: string): void { this.execute(["app", "stop", packageName]); }
  installApp(path: string): string { return stringifyData(this.execute(["package", "install", path], 120_000)); }
  uninstallApp(packageName: string): string { return stringifyData(this.execute(["package", "uninstall", packageName], 120_000)); }
  listPackages(filter?: string): string[] {
    const args = ["package", "list"];
    if (filter) args.push("--filter", filter);
    const data = this.execute<unknown[]>(args);
    return data.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const value = item as Record<string, unknown>;
        return String(value.name ?? value.package ?? value.id ?? JSON.stringify(value));
      }
      return String(item);
    });
  }

  shell(command: string, root = false): string {
    const args = ["shell"];
    if (root) args.push("--root");
    args.push(command);
    const data = this.execute<unknown>(args);
    return typeof data === "object" && data !== null && "output" in data
      ? String((data as { output: unknown }).output)
      : stringifyData(data);
  }
  getLogs(options: LogOptions = {}): string {
    const args: string[] = ["logs"];
    if (options.lines !== undefined) args.push("--lines", String(Math.trunc(options.lines)));
    if (options.priority) args.push("--priority", options.priority);
    if (options.unit) args.push("--unit", options.unit);
    if (options.grep) args.push("--grep", options.grep);
    if (options.since) args.push("--since", options.since);
    if (options.kernel) args.push("--kernel");
    const data = this.execute<unknown>(args);
    return typeof data === "object" && data !== null && "output" in data
      ? String((data as { output: unknown }).output)
      : stringifyData(data);
  }
  clearLogs(): string { return stringifyData(this.execute(["logs", "--clear", "--force"])); }
  getSystemInfo(category?: string): string {
    const args = ["info"];
    if (category) args.push(category);
    return stringifyData(this.execute(args));
  }
  pushFile(localPath: string, remotePath: string): string {
    return stringifyData(this.execute(["push", localPath, remotePath]));
  }
  pullFile(remotePath: string, localPath?: string): Buffer {
    const local = localPath || `${tmpdir()}/aurora_pull_${randomBytes(8).toString("hex")}`;
    const removeAfterRead = !localPath;
    try {
      this.execute(["pull", remotePath, "--output", local]);
      if (!existsSync(local)) throw new AudbCommandError("AUDB_PULL_FAILED", `audb did not create output file: ${local}`);
      return readFileSync(local);
    } finally {
      if (removeAfterRead) try { unlinkSync(local); } catch {}
    }
  }
}

export const auroraClient = new AuroraClient();
