import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { MobileError } from "mcp-devices/errors";
import {
  validateDeviceId,
  validatePackageName,
  validatePath,
  validatePermission,
  validateUrl,
} from "mcp-devices/utils/sanitize";
import { buildDeviceShellCommand } from "mcp-devices/utils/device-shell";
import { readPrivateFileSync } from "mcp-devices/utils/private-storage";

const EXEC_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const MAX_ARKWEB_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ARKWEB_TARGETS = 1000;
const MAX_UI_HIERARCHY_BYTES = 16 * 1024 * 1024;
const ABILITY_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]*$/;
const MODULE_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]*$/;
const HARMONY_KEY_IDS: Readonly<Record<string, string>> = Object.freeze({
  BACK: "Back",
  HOME: "Home",
  POWER: "Power",
  ENTER: "2054",
  RETURN: "2054",
  TAB: "2049",
  SPACE: "2050",
  DELETE: "2055",
  BACKSPACE: "2055",
  ESCAPE: "2070",
  ESC: "2070",
});

function resolveHarmonyKey(key: string): string {
  const normalized = key.trim().toUpperCase();
  const mapped = HARMONY_KEY_IDS[normalized];
  if (mapped) return mapped;
  if (/^\d+$/.test(normalized)) return normalized;
  throw new MobileError(
    "Unknown HarmonyOS key.",
    "INVALID_KEY",
  );
}

function swipeVelocity(
  x1: number,
  y1: number,
  x2: number,


  y2: number,
  durationMs: number,
): string {
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 300;
  const pixelsPerSecond = Math.round((Math.hypot(x2 - x1, y2 - y1) * 1_000) / duration);
  return String(Math.max(200, Math.min(40_000, pixelsPerSecond)));
}

export interface HarmonyDevice {
  id: string;
  name: string;
  platform: "harmony";
  state: string;
  isSimulator: boolean;
  connection?: string;
}

export interface HarmonyLogOptions {
  level?: string;
  tag?: string;
  lines?: number;
  package?: string;
}

export interface ArkWebTarget {
  [key: string]: unknown;
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface ArkWebInspection {
  socket: string;
  forwardedPort: number;
  targets: ArkWebTarget[];
}

export interface HarmonyTestOptions {
  class?: string;
  notClass?: string;
  timeoutMs?: number;
  dryRun?: boolean;
}

export interface HdcFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type HdcFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<HdcFetchResponse>;

interface ArkWebForward {
  socket: string;
  port: number;
  deviceId?: string;
}

interface AccessTokenPermission {
  permissionName: string;
  grantStatus: number;
}

interface AccessTokenState {
  tokenId: string;
  permissions: AccessTokenPermission[];
}
const accessTokenPermissionSchema = z.object({
  permissionName: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/),
  grantStatus: z.union([
    z.number().finite(),
    z.string().min(1).max(32),
  ]),
}).passthrough();
const accessTokenResponseSchema = z.object({
  tokenId: z.union([
    z.number().int().safe().nonnegative(),
    z.string().min(1).max(64).regex(/^\d+$/),
  ]).optional(),
  permStateList: z.array(accessTokenPermissionSchema).max(10_000).optional(),
}).passthrough();
const arkWebTargetSchema = z.object({
  id: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
  title: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
  type: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
  url: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
  webSocketDebuggerUrl: z.string().max(8192).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
}).passthrough();
const arkWebTargetsSchema = z.array(arkWebTargetSchema).max(MAX_ARKWEB_TARGETS);

export type HdcExecutor = (
  binary: string,
  args: readonly string[],
) => string;

export interface HdcClientOptions {
  hdcPath?: string;
  executor?: HdcExecutor;
  deviceId?: string;
  fetcher?: HdcFetch;
}

function defaultExecutor(binary: string, args: readonly string[]): string {
  return execFileSync(binary, [...args], {
    encoding: "utf-8",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: EXEC_TIMEOUT_MS,
  }).trim();
}
async function defaultHdcFetch(
  url: string,
  init?: { signal?: AbortSignal },
): Promise<HdcFetchResponse> {
  const response = await fetch(url, { ...init, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, status: response.status, json: async () => undefined };
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARKWEB_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new MobileError(
      "ArkWeb DevTools response exceeded the size limit.",
      "INVALID_ARKWEB_RESPONSE",
    );
  }
  if (!response.body) {
    throw new MobileError("ArkWeb DevTools returned no response body.", "INVALID_ARKWEB_RESPONSE");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ARKWEB_RESPONSE_BYTES) {
      await reader.cancel();
      throw new MobileError(
        "ArkWeb DevTools response exceeded the size limit.",
        "INVALID_ARKWEB_RESPONSE",
      );
    }
    chunks.push(Buffer.from(value));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  return { ok: true, status: response.status, json: async () => parsed };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}


function validateAbilityName(ability: string): void {
  if (!ABILITY_NAME_RE.test(ability)) {
    throw new MobileError(
      "Invalid HarmonyOS ability name.",
      "INVALID_ABILITY_NAME",
    );
  }
}

function validateModuleName(moduleName: string): void {
  if (!MODULE_NAME_RE.test(moduleName)) {
    throw new MobileError(
      "Invalid HarmonyOS module name.",
      "INVALID_MODULE_NAME",
    );
  }
}

function validateSandboxPath(path: string, label: string): void {
  validatePath(path, label);
  if (
    path.length === 0 ||
    path.length > 1024 ||
    path.startsWith("/") ||
    !/^[A-Za-z0-9_./-]+$/.test(path)
  ) {
    throw new MobileError(
      `Invalid HarmonyOS sandbox ${label}.`,
      "INVALID_SANDBOX_PATH",
    );
  }
}

function validateArkWebSocket(socket: string): void {
  if (!/^webview_devtools_remote_[A-Za-z0-9_.-]+$/.test(socket)) {
    throw new MobileError(
      "Invalid ArkWeb DevTools socket.",
      "INVALID_ARKWEB_SOCKET",
    );
  }
}

function validateLocalPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new MobileError(
      `Invalid local port: ${port}`,
      "INVALID_LOCAL_PORT",
    );
  }
}

function validateTestFilter(value: string, label: string): void {
  if (value.length === 0 || value.length > 512 || !/^[A-Za-z0-9_.#,/-]+$/.test(value)) {
    throw new MobileError(
      `Invalid HarmonyOS test ${label}.`,
      "INVALID_TEST_FILTER",
    );
  }
}

function accessTokenState(output: string): AccessTokenState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = undefined;
  }

  const tokenMatch = output.match(/"?tokenId"?\s*:\s*(\d+)/);
  const result = accessTokenResponseSchema.safeParse(parsed);
  const rawToken = result.success ? result.data.tokenId : undefined;
  const tokenId = rawToken === undefined ? tokenMatch?.[1] : String(rawToken);
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    throw new MobileError(
      "ATM response did not contain a valid tokenId",
      "INVALID_ATM_RESPONSE",
    );
  }

  const permissions: AccessTokenPermission[] = [];
  for (const item of result.success ? result.data.permStateList ?? [] : []) {
    const grantStatus = typeof item.grantStatus === "number"
      ? item.grantStatus
      : Number(item.grantStatus);
    if (!Number.isFinite(grantStatus)) continue;
    permissions.push({
      permissionName: item.permissionName,
      grantStatus,
    });
  }
  return { tokenId, permissions };
}

function parseLaunchTarget(value: string): { bundleId: string; ability: string } {
  const separator = value.indexOf("/");
  const bundleId = separator === -1 ? value : value.slice(0, separator);
  const ability = separator === -1 ? "EntryAbility" : value.slice(separator + 1);
  validatePackageName(bundleId);
  validateAbilityName(ability);
  return { bundleId, ability };
}

export class HdcClient {
  private readonly hdcPath: string;
  private readonly executor: HdcExecutor;
  private readonly fetcher: HdcFetch;
  private readonly arkWebForwards: ArkWebForward[] = [];
  private selectedDeviceId?: string;

  constructor(options: HdcClientOptions = {}) {
    this.hdcPath = options.hdcPath ?? process.env.HDC_PATH ?? "hdc";
    this.executor = options.executor ?? defaultExecutor;
    this.fetcher = options.fetcher ?? defaultHdcFetch;
    const configuredDeviceId = options.deviceId ?? process.env.HARMONY_DEVICE_ID;
    if (configuredDeviceId) this.setDevice(configuredDeviceId);
  }

  checkAvailability(): boolean {
    try {
      this.runHost(["version"]);
      return true;
    } catch {
      return false;
    }
  }

  setDevice(deviceId: string): void {
    validateDeviceId(deviceId);
    this.selectedDeviceId = deviceId;
  }

  getDeviceId(): string | undefined {
    return this.selectedDeviceId;
  }

  listDevices(): HarmonyDevice[] {
    const output = this.runHost(["list", "targets", "-v"]);
    if (!output) return [];
    const devices: HarmonyDevice[] = [];
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("[Empty]")) continue;
      const fields = line.split(/\s+/);
      const id = fields[0];
      if (!id || id.startsWith("[")) continue;
      const connection = fields[1];
      const rawState = fields.find((field) =>
        /^(Connected|Ready|Offline|Unauthorized|Unknown)$/i.test(field)
      );
      const state = rawState?.toLowerCase() ?? "connected";
      devices.push({
        id,
        name: fields[3] && !/^(hdc|localhost)$/i.test(fields[3]) ? fields[3] : id,
        platform: "harmony",
        state,
        isSimulator: /emulator|simulator/i.test(line),
        connection,
      });
    }
    return devices;
  }

  tap(x: number, y: number, deviceId?: string): void {
    this.runShell(["uitest", "uiInput", "click", String(x), String(y)], deviceId);
  }

  doubleTap(x: number, y: number, deviceId?: string): void {
    this.runShell(["uitest", "uiInput", "doubleClick", String(x), String(y)], deviceId);
  }

  longPress(x: number, y: number, durationMs = 1_000, deviceId?: string): void {
    this.runShell(["uitest", "uiInput", "longClick", String(x), String(y), String(durationMs)], deviceId);
  }

  swipe(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 300,
    deviceId?: string,
  ): void {
    const velocity = swipeVelocity(x1, y1, x2, y2, durationMs);
    this.runShell(
      ["uitest", "uiInput", "swipe", String(x1), String(y1), String(x2), String(y2), velocity],
      deviceId,
    );
  }

  swipeDirection(
    direction: "up" | "down" | "left" | "right",
    deviceId?: string,
  ): void {
    const directionCode = { left: "0", right: "1", up: "2", down: "3" }[direction];
    this.runShell(["uitest", "uiInput", "dircFling", directionCode], deviceId);
  }

  inputText(text: string, deviceId?: string): void {
    this.runShell(["uitest", "uiInput", "text", text], deviceId);
  }

  pressKey(key: string, deviceId?: string): void {
    this.runShell(["uitest", "uiInput", "keyEvent", resolveHarmonyKey(key)], deviceId);
  }

  screenshotRaw(deviceId?: string): Buffer {
    const nonce = randomBytes(8).toString("hex");
    const remotePath = `/data/local/tmp/mcp-devices-${nonce}.png`;
    const localDir = mkdtempSync(join(tmpdir(), "mcp-devices-harmony-"));
    const localPath = join(localDir, "capture.png");
    try {
      this.runShell(["uitest", "screenCap", "-p", remotePath], deviceId);
      this.run(["file", "recv", remotePath, localPath], deviceId);
      return readPrivateFileSync(localPath, MAX_BUFFER_BYTES, "HarmonyOS screenshot");
    } finally {
      rmSync(localDir, { recursive: true, force: true });
      try { this.runShell(["rm", "-f", remotePath], deviceId); } catch {}
    }
  }

  screenshot(deviceId?: string): string {
    return this.screenshotRaw(deviceId).toString("base64");
  }

  getUiHierarchy(deviceId?: string): string {
    const nonce = randomBytes(8).toString("hex");
    const remotePath = `/data/local/tmp/mcp-devices-ui-${nonce}.json`;
    const localDir = mkdtempSync(join(tmpdir(), "mcp-devices-harmony-"));
    const localPath = join(localDir, "hierarchy.json");
    try {
      this.runShell(["uitest", "dumpLayout", "-p", remotePath], deviceId);
      this.run(["file", "recv", remotePath, localPath], deviceId);
      return readPrivateFileSync(
        localPath,
        MAX_UI_HIERARCHY_BYTES,
        "HarmonyOS UI hierarchy",
      ).toString("utf8");
    } finally {
      rmSync(localDir, { recursive: true, force: true });
      try { this.runShell(["rm", "-f", remotePath], deviceId); } catch {}
    }
  }

  launchApp(target: string, deviceId?: string): string {
    const { bundleId, ability } = parseLaunchTarget(target);
    return this.launchAbility(bundleId, ability, undefined, deviceId);
  }

  launchAbility(
    bundleId: string,
    ability = "EntryAbility",
    moduleName?: string,
    deviceId?: string,
  ): string {
    validatePackageName(bundleId);
    validateAbilityName(ability);
    const args = ["aa", "start", "-b", bundleId, "-a", ability];
    if (moduleName) {
      validateModuleName(moduleName);
      args.push("-m", moduleName);
    }
    const output = this.runShell(args, deviceId);
    const target = moduleName
      ? `${bundleId}/${moduleName}/${ability}`
      : `${bundleId}/${ability}`;
    return output || `Launched ${target}`;
  }

  openUrl(url: string, deviceId?: string): string {
    validateUrl(url);
    const output = this.runShell(["aa", "start", "-A", "ohos.want.action.viewData", "-U", url], deviceId);
    return output || "URL opened";
  }

  stopApp(bundleId: string, deviceId?: string): void {
    validatePackageName(bundleId);
    this.runShell(["aa", "force-stop", bundleId], deviceId);
  }

  installApp(localPath: string, deviceId?: string): string {
    validatePath(localPath, "app path");
    const output = this.run(["install", "-r", localPath], deviceId);
    return output || `Installed ${localPath}`;
  }

  uninstallApp(bundleId: string, deviceId?: string): string {
    validatePackageName(bundleId);
    const output = this.run(["uninstall", bundleId], deviceId);
    return output || `Uninstalled ${bundleId}`;
  }

  listPackages(deviceId?: string): string[] {
    const output = this.runShell(["bm", "dump", "-a"], deviceId);
    const packages = new Set<string>();
    for (const match of output.matchAll(/bundleName\s*[:=]\s*"?([A-Za-z][A-Za-z0-9_.]*)"?/g)) {
      packages.add(match[1]!);
    }
    for (const line of output.split(/\r?\n/)) {
      const value = line.trim();
      if (/^[A-Za-z][A-Za-z0-9_.]*\.[A-Za-z0-9_.]+$/.test(value)) packages.add(value);
    }
    return [...packages].sort();
  }

  shell(command: string, deviceId?: string): string {
    return this.run(["shell", command], deviceId);
  }

  getLogs(options: HarmonyLogOptions = {}, deviceId?: string): string {
    let lines = this.run(["hilog", "-x"], deviceId).split(/\r?\n/);
    for (const filter of [options.level, options.tag, options.package]) {
      if (filter) lines = lines.filter((line) => line.includes(filter));
    }
    const limit = options.lines === undefined
      ? 500
      : Math.max(1, Math.min(10_000, Math.trunc(options.lines)));
    return lines.slice(-limit).join("\n");
  }

  clearLogs(deviceId?: string): string {
    const output = this.runShell(["hilog", "-r"], deviceId);
    return output || "HarmonyOS HiLog buffers cleared";
  }

  getSystemInfo(deviceId?: string): string {
    return this.runShell(["param", "get"], deviceId);
  }

  pushFile(localPath: string, remotePath: string, deviceId?: string): string {
    validatePath(localPath, "localPath");
    validatePath(remotePath, "remotePath");
    const output = this.run(["file", "send", localPath, remotePath], deviceId);
    return output || `Uploaded ${localPath} → ${remotePath}`;
  }

  pullFile(remotePath: string, localPath: string, deviceId?: string): string {
    validatePath(remotePath, "remotePath");
    validatePath(localPath, "localPath");
    const output = this.run(["file", "recv", remotePath, localPath], deviceId);
    return output || `Downloaded ${remotePath} → ${localPath}`;
  }

  grantPermission(bundleId: string, permission: string, deviceId?: string): string {
    validatePackageName(bundleId);
    validatePermission(permission);
    const { tokenId } = accessTokenState(
      this.runShell(["atm", "dump", "-t", "-b", bundleId], deviceId),
    );
    const output = this.runShell(["atm", "perm", "-g", "-i", tokenId, "-p", permission], deviceId);
    return output || `Granted ${permission} to ${bundleId}`;
  }

  revokePermission(bundleId: string, permission: string, deviceId?: string): string {
    validatePackageName(bundleId);
    validatePermission(permission);
    const { tokenId } = accessTokenState(
      this.runShell(["atm", "dump", "-t", "-b", bundleId], deviceId),
    );
    const output = this.runShell(["atm", "perm", "-c", "-i", tokenId, "-p", permission], deviceId);
    return output || `Revoked ${permission} from ${bundleId}`;
  }

  resetPermissions(bundleId: string, deviceId?: string): string {
    validatePackageName(bundleId);
    const initial = accessTokenState(
      this.runShell(["atm", "dump", "-t", "-b", bundleId], deviceId),
    );
    const state = accessTokenState(
      this.runShell(["atm", "dump", "-t", "-i", initial.tokenId], deviceId),
    );
    const failures: string[] = [];
    let revoked = 0;
    for (const permission of state.permissions) {
      if (permission.grantStatus !== 0) continue;
      try {
        this.runShell(
          ["atm", "perm", "-c", "-i", state.tokenId, "-p", permission.permissionName],
          deviceId,
        );
        revoked += 1;
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${permission.permissionName}: ${detail}`);
      }
    }
    if (failures.length > 0) {
      throw new MobileError(
        `Reset permissions for ${bundleId} revoked ${revoked}, but ${failures.length} failed: ${failures.join("; ")}`,
        "HDC_PERMISSION_RESET_FAILED",
      );
    }
    return `Reset ${revoked} granted permissions for ${bundleId}`;
  }

  sandboxList(bundleId: string, path = ".", deviceId?: string): string {
    validatePackageName(bundleId);
    validateSandboxPath(path, "path");
    return this.runSandboxShell(bundleId, ["ls", "-la", path], deviceId);
  }

  sandboxRead(bundleId: string, path: string, maxBytes?: number, deviceId?: string): string {
    validatePackageName(bundleId);
    validateSandboxPath(path, "path");
    const output = this.runSandboxShell(bundleId, ["cat", path], deviceId);
    if (maxBytes === undefined) return output;
    if (!Number.isInteger(maxBytes) || maxBytes < 0) {
      throw new MobileError(
        `Invalid maxBytes: ${maxBytes}`,
        "INVALID_MAX_BYTES",
      );
    }
    return Buffer.from(output).subarray(0, maxBytes).toString("utf-8");
  }

  sandboxPush(
    bundleId: string,
    localPath: string,
    remotePath: string,
    deviceId?: string,
  ): string {
    validatePackageName(bundleId);
    validatePath(localPath, "localPath");
    validateSandboxPath(remotePath, "remotePath");
    const output = this.run(
      ["file", "send", "-b", bundleId, localPath, remotePath],
      deviceId,
    );
    return output || `Uploaded ${localPath} → ${bundleId}:${remotePath}`;
  }

  sandboxPull(
    bundleId: string,
    remotePath: string,
    localPath: string,
    deviceId?: string,
  ): string {
    validatePackageName(bundleId);
    validateSandboxPath(remotePath, "remotePath");
    validatePath(localPath, "localPath");
    const output = this.run(
      ["file", "recv", "-b", bundleId, remotePath, localPath],
      deviceId,
    );
    return output || `Downloaded ${bundleId}:${remotePath} → ${localPath}`;
  }

  discoverArkWebSockets(deviceId?: string): string[] {
    const output = this.runShell(["cat", "/proc/net/unix"], deviceId);
    const sockets = new Set<string>();
    for (const line of output.split(/\r?\n/)) {
      const socket = line.trim().split(/\s+/).at(-1)?.replace(/^@/, "");
      if (!socket || !socket.startsWith("webview_devtools_remote_")) continue;
      try {
        validateArkWebSocket(socket);
        sockets.add(socket);
      } catch {}
    }
    return [...sockets].sort();
  }

  async inspectArkWeb(
    socketName?: string,
    localPort = 9_222,
    deviceId?: string,
  ): Promise<ArkWebInspection> {
    validateLocalPort(localPort);
    const socket = socketName ?? this.discoverArkWebSockets(deviceId)[0];
    if (!socket) {
      throw new MobileError(
        "No ArkWeb DevTools socket found. Enable setWebDebuggingAccess(true).",
        "ARKWEB_NOT_FOUND",
      );
    }
    validateArkWebSocket(socket);
    this.run(
      ["fport", `tcp:${localPort}`, `localabstract:${socket}`],
      deviceId,
    );
    this.arkWebForwards.push({ socket, port: localPort, deviceId });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.fetcher(
        `http://127.0.0.1:${localPort}/json/list`,
        { signal: controller.signal },
      );
      if (!response.ok) {
        throw new MobileError(
          `ArkWeb DevTools returned HTTP ${response.status}`,
          "ARKWEB_HTTP_ERROR",
        );
      }
      const targetsResult = arkWebTargetsSchema.safeParse(await response.json());
      if (!targetsResult.success) {
        throw new MobileError(
          "ArkWeb DevTools /json/list response is invalid.",
          "INVALID_ARKWEB_RESPONSE",
        );
      }
      const targets: ArkWebTarget[] = targetsResult.data;
      return {
        socket,
        forwardedPort: localPort,
        targets,
      };
    } catch (error: unknown) {
      try {
        this.closeArkWeb(socket, localPort, deviceId);
      } catch {}
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  closeArkWeb(socket: string, localPort: number, deviceId?: string): string {
    validateArkWebSocket(socket);
    validateLocalPort(localPort);
    const output = this.run(
      ["fport", "rm", `tcp:${localPort}`, `localabstract:${socket}`],
      deviceId,
    );
    for (let index = this.arkWebForwards.length - 1; index >= 0; index -= 1) {
      const rule = this.arkWebForwards[index]!;
      if (
        rule.socket === socket
        && rule.port === localPort
        && rule.deviceId === deviceId
      ) {
        this.arkWebForwards.splice(index, 1);
      }
    }
    return output || `Closed ArkWeb forward on port ${localPort}`;
  }

  runTests(
    bundleId: string,
    moduleName: string,
    runner = "OpenHarmonyTestRunner",
    options: HarmonyTestOptions = {},
    deviceId?: string,
  ): string {
    validatePackageName(bundleId);
    validateModuleName(moduleName);
    validateSandboxPath(runner, "test runner");
    const args = [
      "aa", "test", "-b", bundleId, "-m", moduleName,
      "-s", "unittest", runner,
    ];
    for (const [name, value] of [
      ["class", options.class],
      ["notClass", options.notClass],
    ] as const) {
      if (value) {
        validateTestFilter(value, name);
        args.push("-s", name, value);
      }
    }
    if (options.timeoutMs !== undefined) {
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
        throw new MobileError(
          `Invalid test timeout: ${options.timeoutMs}`,
          "INVALID_TEST_TIMEOUT",
        );
      }
      args.push("-s", "timeout", String(options.timeoutMs));
    }
    if (options.dryRun) args.push("-s", "dryRun", "true");
    return this.runShell(args, deviceId);
  }

  dispose(): void {
    for (const rule of this.arkWebForwards.splice(0)) {
      try {
        this.run(
          [
            "fport", "rm", `tcp:${rule.port}`,
            `localabstract:${rule.socket}`,
          ],
          rule.deviceId,
        );
      } catch {}
    }
  }

  private run(args: readonly string[], deviceId?: string): string {
    const target = deviceId ?? this.selectedDeviceId;
    if (target) validateDeviceId(target);
    const targetArgs = target ? ["-t", target, ...args] : [...args];
    return this.runHost(targetArgs);
  }

  private runShell(args: readonly string[], deviceId?: string): string {
    return this.run(["shell", buildDeviceShellCommand(args)], deviceId);
  }

  private runSandboxShell(
    bundleId: string,
    args: readonly string[],
    deviceId?: string,
  ): string {
    return this.run(
      ["shell", "-b", bundleId, buildDeviceShellCommand(args)],
      deviceId,
    );
  }

  private runHost(args: readonly string[]): string {
    try {
      return this.executor(this.hdcPath, args).trim();
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") {
        throw new MobileError(
          "hdc was not found. Add the DevEco Studio SDK toolchains directory to PATH or set HDC_PATH.",
          "HDC_NOT_FOUND",
        );
      }
      const commandIndex = args[0] === "-t" ? 2 : 0;
      const command = args[commandIndex] ?? "unknown";
      throw new MobileError(
        `HDC ${command} command failed.`,
        "HDC_COMMAND_FAILED",
      );
    }
  }
}
