import { execFileSync } from "child_process";
import { accessSync, constants, readFileSync, rmSync, statSync } from "fs";
import { delimiter, join, resolve, basename } from "path";
import { MobileError } from "mcp-devices/errors";
import { validateDeviceId } from "mcp-devices/utils/sanitize";
import { makePrivateTempDir, readPrivateFileSync } from "mcp-devices/utils/private-storage";

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
  level?: string;
  unit?: string;
  grep?: string;
  package?: string;
  since?: string;
  tag?: string;
}
export class AudbCommandError extends MobileError {
  constructor(code: string, message: string, public readonly data?: unknown,
    public readonly deviceId?: string | null, public readonly exitStatus?: number | null) {
    super(data === undefined ? message : `${message}\n${JSON.stringify({ deviceId, exitStatus, data })}`, code);
    this.name = "AudbCommandError";
  }
}
export interface AuroraClientOptions {
  deviceId?: string;
  /** Explicit dependency injection; environment resolution prefers PATH. */
  binaryPath?: string;
}
// audb is an external Rust CLI, not an npm dependency. Declare its public API
// requirement in the plugin manifest and enforce the pre-1.0 caret range here.
const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  externalTools: { audb: { version: string; jsonSchemaVersion: number } };
};
const AUDB_CONTRACT = metadata.externalTools.audb;
const supportedVersion = AUDB_CONTRACT.version.match(/^\^0\.(\d+)\.(\d+)$/);
if (!supportedVersion || AUDB_CONTRACT.jsonSchemaVersion !== 1) {
  throw new Error("Invalid Aurora plugin audb contract; expected ^0.MINOR.PATCH and schemaVersion 1.");
}
const SUPPORTED_MINOR = Number(supportedVersion[1]);
const MINIMUM_PATCH = Number(supportedVersion[2]);
const MAX_OUTPUT = 64 * 1024 * 1024;
const INSTALL = "cargo install audb-client --version 0.3.0 --locked";

/** PATH always precedes AUDB_PATH. A broken/old PATH binary is not bypassed. */
export function resolveAudbPath(): string {
  const name = process.platform === "win32" ? "audb.exe" : "audb";
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    const candidate = resolve(directory || ".", name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* next PATH entry */ }
  }
  if (process.env.AUDB_PATH) return resolve(process.env.AUDB_PATH);
  throw new AudbCommandError("AUDB_NOT_INSTALLED", `audb not found in PATH. Install: ${INSTALL}, or set AUDB_PATH.`);
}
function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "output" in value && typeof value.output === "string") return value.output;
  return JSON.stringify(value, null, 2);
}

export class AuroraClient {
  private binary?: string;
  private versionChecked = false;
  private selectedDeviceId?: string;
  constructor(private readonly options: AuroraClientOptions = {}) {
    if (options.deviceId) validateDeviceId(options.deviceId);
    this.selectedDeviceId = options.deviceId;
  }
  private ensureVersion(): string {
    this.binary ??= this.options.binaryPath ?? resolveAudbPath();
    if (this.versionChecked) return this.binary;
    let version: string;
    try {
      version = execFileSync(this.binary, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }).trim();
    } catch {
      throw new AudbCommandError("AUDB_VERSION_CHECK_FAILED", `Cannot run audb --version. Install/update audb in PATH: ${INSTALL}`);
    }
    const match = version.match(/^audb (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    if (!match || Number(match[1]) !== 0 || Number(match[2]) !== SUPPORTED_MINOR ||
        !Number.isSafeInteger(Number(match[3])) || Number(match[3]) < MINIMUM_PATCH) {
      throw new AudbCommandError("AUDB_VERSION_UNSUPPORTED", `audb ${AUDB_CONTRACT.version} is required. Update the binary in PATH: ${INSTALL} --force`);
    }
    this.versionChecked = true;
    return this.binary;
  }
  private parseEnvelope<T>(raw: string, status?: number | null, expectedDevice?: string): T {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new AudbCommandError("AUDB_INVALID_RESPONSE", "audb returned invalid JSON; the command was not repeated.", undefined, expectedDevice, status);
    }
    const envelope = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
    if (!envelope || envelope.schemaVersion !== 1 || typeof envelope.ok !== "boolean" ||
        !(envelope.deviceId === null || typeof envelope.deviceId === "string")) {
      throw new AudbCommandError("AUDB_INVALID_RESPONSE", "Unsupported audb JSON envelope; expected schemaVersion 1.", undefined, expectedDevice, status);
    }
    if (!envelope.ok) {
      const error = envelope.error && typeof envelope.error === "object" ? envelope.error as Record<string, unknown> : undefined;
      if (typeof error?.code !== "string" || typeof error.message !== "string") {
        throw new AudbCommandError("AUDB_INVALID_RESPONSE", "audb returned malformed error metadata.", undefined, expectedDevice, status);
      }
      throw new AudbCommandError(error.code, error.message,
        envelope.data, envelope.deviceId, status);
    }
    if (status !== 0 || (expectedDevice && envelope.deviceId !== expectedDevice) || !("data" in envelope)) {
      throw new AudbCommandError("AUDB_INVALID_RESPONSE", "audb returned inconsistent success metadata; the command was not repeated.", envelope.data, envelope.deviceId, status);
    }
    return envelope.data as T;
  }
  /** No shell, no action retries. Registry calls are untargeted. */
  execute<T = unknown>(args: string[], seconds = 120, input?: Buffer, registry = false): T {
    const binary = this.ensureVersion();
    const device = registry ? undefined : this.getActiveDevice();
    const argv = ["--json", "--command-timeout", String(seconds), ...(device ? ["--device", device] : []), ...args];
    let raw: string;
    try {
      raw = execFileSync(binary, argv, { encoding: "utf8", input, timeout: seconds * 1000 + 5000, maxBuffer: MAX_OUTPUT });
    } catch (error) {
      const e = error as { stdout?: string | Buffer; status?: number | null; code?: string };
      if (e.stdout?.length) return this.parseEnvelope<T>(e.stdout.toString(), e.status, device);
      throw new AudbCommandError("OUTCOME_UNKNOWN", "audb response was lost or execution timed out; the command was not repeated.", undefined, device, e.status);
    }
    return this.parseEnvelope<T>(raw, 0, device);
  }
  async checkAvailability(): Promise<boolean> {
    try { this.ensureVersion(); return true; } catch { return false; }
  }
  listDevices(): Device[] {
    const records = this.execute<{ id: string; name: string; kind: string; state: string; host?: string }[]>(["device", "list"], 120, undefined, true);
    if (!Array.isArray(records) || records.some(d => !d || typeof d.id !== "string" || !["emulator", "physical"].includes(d.kind) || typeof d.state !== "string")) {
      throw new AudbCommandError("AUDB_INVALID_RESPONSE", "Invalid audb device inventory.");
    }
    return records.map(d => ({ id: d.id, name: d.name, platform: "aurora", state: d.state, isSimulator: d.kind === "emulator", host: d.host }));
  }
  selectDevice(id: string): void { validateDeviceId(id); this.selectedDeviceId = id; }
  getSelectedDeviceId(): string | undefined { return this.selectedDeviceId; }
  getActiveDevice(): string {
    if (this.selectedDeviceId) return this.selectedDeviceId;
    const record = this.execute<{ id: string }>(["device", "current"], 120, undefined, true);
    if (!record || typeof record.id !== "string") throw new AudbCommandError("AUDB_INVALID_RESPONSE", "Invalid audb default device.");
    validateDeviceId(record.id);
    return record.id;
  }
  forDevice(id?: string): AuroraClient {
    return new AuroraClient({ ...this.options, binaryPath: this.binary ?? this.options.binaryPath, deviceId: id ?? this.getActiveDevice() });
  }
  tap(x: number, y: number): void { this.execute(["tap", String(x), String(y)]); }
  longPress(x: number, y: number, duration: number): void { this.execute(["tap", String(x), String(y), "--duration", String(duration)]); }
  swipeDirection(direction: string): void { this.execute(["swipe", direction]); }
  swipeCoords(x1: number, y1: number, x2: number, y2: number, durationMs?: number): void {
    this.execute(["swipe", String(x1), String(y1), String(x2), String(y2), ...(durationMs === undefined ? [] : ["--duration", String(durationMs)])]);
  }
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): void { this.swipeCoords(x1, y1, x2, y2, durationMs); }
  inputText(text: string): void { this.execute(["text", "--stdin"], 120, Buffer.from(text, "utf8")); }
  pressKey(key: string): void { this.execute(["key", key]); }
  getUiHierarchy(): never { throw new MobileError("Aurora UI hierarchy is not supported by audb.", "CAPABILITY_NOT_SUPPORTED"); }
  clearAppData(_package: string): never { throw new MobileError("Aurora app-data clearing is outside this integration.", "CAPABILITY_NOT_SUPPORTED"); }
  screenshotRaw(): Buffer {
    const dir = makePrivateTempDir("aurora-screenshot");
    const path = join(dir, "screen.png");
    try {
      this.execute(["screenshot", "--output", path]);
      return readPrivateFileSync(path, MAX_OUTPUT, "Aurora screenshot");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  screenshot(): string { return this.screenshotRaw().toString("base64"); }
  launchApp(id: string): string { return outputText(this.execute(["app", "launch", id])); }
  openUrl(url: string): string { return outputText(this.execute(["open", url])); }
  stopApp(id: string): void { this.execute(["app", "stop", id]); }
  installApp(path: string): string { return outputText(this.execute(["package", "install", path], 300)); }
  uninstallApp(id: string): string { return outputText(this.execute(["package", "uninstall", id])); }
  listPackages(): string[] {
    const data = this.execute<{ packages: string[] }>(["package", "list"]);
    if (!Array.isArray(data.packages)) throw new AudbCommandError("AUDB_INVALID_RESPONSE", "Invalid audb package inventory.");
    return data.packages;
  }
  pushFile(local: string, remote: string): string { return outputText(this.execute(["push", local, remote])); }
  pullFile(remote: string, local?: string): string {
    return outputText(this.execute(["pull", remote, "--output", local ?? (basename(remote) || "pulled_file")]));
  }
  shell(command: string, root = false): string { return outputText(this.execute(["shell", ...(root ? ["--root"] : []), command])); }
  getLogs(options: LogOptions = {}): string {
    if (options.tag) throw new MobileError("Aurora logs do not support Android tag filters.", "CAPABILITY_NOT_SUPPORTED");
    const args = ["logs", "--lines", String(options.lines ?? 100)];
    for (const [flag, value] of [["--priority", options.priority ?? options.level], ["--unit", options.unit], ["--grep", options.grep ?? options.package], ["--since", options.since]]) {
      if (value !== undefined) args.push(flag!, value);
    }
    return outputText(this.execute(args));
  }
  clearLogs(): string { return outputText(this.execute(["logs", "--clear", "--force"])); }
  getSystemInfo(): string { return outputText(this.execute(["info"])); }
  permissionList(id: string): string { return outputText(this.execute(["permission", "list", id])); }
  grantPermission(id: string, permission: string, disablePrompt = false): string {
    return outputText(this.execute(["permission", "grant", id, permission, ...(disablePrompt ? ["--disable-prompt"] : [])]));
  }
  grantAllPermissions(id: string, disablePrompt = false): string {
    return outputText(this.execute(["permission", "grant", id, "--all-requested", ...(disablePrompt ? ["--disable-prompt"] : [])]));
  }
  revokePermission(id: string, permission: string): string { return outputText(this.execute(["permission", "revoke", id, permission])); }
  resetPermissions(id: string): string { return outputText(this.execute(["permission", "reset", id])); }
  permissionPrompt(id: string, enabled: boolean): string { return outputText(this.execute(["permission", "prompt", id, enabled ? "--enable" : "--disable"])); }
}
export const auroraClient = new AuroraClient();
