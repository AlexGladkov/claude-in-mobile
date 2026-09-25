import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants, readdirSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, opendir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { PluginPermission } from "@mcp-devices/plugin-api";
import { writeJsonAtomic } from "../utils/json-file.js";
import {
  ensurePrivateDirectory,
  ensurePrivateDirectorySync,
  readPrivateFile,
} from "../utils/private-storage.js";

const execFileAsync = promisify(execFile);

export const PLUGIN_LOCK_VERSION = 1 as const;

const MAX_LOCKFILE_BYTES = 1024 * 1024;
export const MAX_PLUGIN_FILES = 8192;
export const MAX_PLUGIN_BYTES = 256 * 1024 * 1024;
const STATE_LOCK_TIMEOUT_MS = 30_000;
const STATE_LOCK_RETRY_MS = 25;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]+$/;
const INTEGRITY_RE = /^sha256-[a-f0-9]{64}$/;
const STATE_LOCK_OWNER_FILE = "owner.json";
const STATE_LOCK_MARKER_FILE = "marker.json";
const STATE_LOCK_CANDIDATE_SUFFIX = ".candidate";
const STATE_LOCK_RECLAIM_PREFIX = ".reclaim-";
const STATE_LOCK_RECLAIM_SUFFIX = ".marker";
const STATE_LOCK_OWNER_BYTES = 16 * 1024;
const SNAPSHOT_PREFIX = ".mcp-devices-plugin-snapshot-";
const SNAPSHOT_PARENT_PREFIX = ".mcp-devices-plugin-snapshots-";
const snapshotParents = new Set<string>();
let snapshotCleanupRegistered = false;

function registerSnapshotParent(parent: string): void {
  snapshotParents.add(resolve(parent));
  if (snapshotCleanupRegistered) return;
  snapshotCleanupRegistered = true;
  process.once("exit", () => {
    for (const snapshotParent of snapshotParents) {
      let entries: readonly string[];
      try {
        entries = readdirSync(snapshotParent);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith(SNAPSHOT_PREFIX)) continue;
        try {
          rmSync(join(snapshotParent, entry), { recursive: true, force: true });
        } catch {
          // Process teardown must not mask the original exit.
        }
      }
    }
  });
}

function prepareSnapshotParent(parent: string): void {
  const resolved = resolve(parent);
  if (!snapshotParents.has(resolved)) {
    if (basename(resolved) === `${SNAPSHOT_PARENT_PREFIX}${process.pid}`) {
      try {
        ensurePrivateDirectorySync(resolved);
        rmSync(resolved, { recursive: true, force: true });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  ensurePrivateDirectorySync(resolved);
  registerSnapshotParent(resolved);
}

interface StateLockOwner {
  readonly pid: number;
  readonly processStartToken?: string;
}

const stateLockOwnerSchema = z.object({
  pid: z.number().int().positive(),
  processStartToken: z.string().min(1).max(128).optional(),
}).passthrough();

interface StateLockReclaimMarker {
  readonly path: string;
  readonly owner: StateLockOwner;
  readonly createdAt: bigint;
}

const stateLockMarkerSchema = z.object({
  createdAt: z.string().regex(/^\d{1,64}$/u),
});

export interface PluginLockEntry {
  readonly id: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly pluginVersion: string;
  readonly apiVersion: "1";
  readonly entry: string;
  readonly integrity: `sha256-${string}`;
  readonly permissions: readonly PluginPermission[];
  readonly source: string;
  readonly installedAt: string;
}

export interface PluginLockfile {
  readonly version: typeof PLUGIN_LOCK_VERSION;
  readonly plugins: Readonly<Record<string, PluginLockEntry>>;
}

const permissionSchema = z.enum([
  "device:read",
  "device:write",
  "filesystem:read",
  "filesystem:write",
  "network",
  "subprocess",
  "credentials:read",
]);

const lockEntrySchema = z.object({
  id: z.string().regex(PLUGIN_ID_RE),
  packageName: z.string().min(1).max(512).regex(SAFE_TEXT_RE),
  packageVersion: z.string().min(1).max(128).regex(SAFE_TEXT_RE),
  pluginVersion: z.string().min(1).max(128).regex(SAFE_TEXT_RE),
  apiVersion: z.literal("1"),
  entry: z.string().min(1).max(1024).regex(SAFE_TEXT_RE),
  integrity: z.string().regex(INTEGRITY_RE),
  permissions: z.array(permissionSchema).max(32),
  source: z.string().min(1).max(512).regex(SAFE_TEXT_RE),
  installedAt: z.string().datetime(),
}).superRefine((entry, ctx) => {
  if (new Set(entry.permissions).size !== entry.permissions.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "plugin lock entry contains duplicate permissions",
      path: ["permissions"],
    });
  }
  if (entry.entry.startsWith("/") || entry.entry.split(/[\\/]/u).includes("..")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "plugin entry must stay inside its package directory",
      path: ["entry"],
    });
  }
});

const lockfileSchema = z.object({
  version: z.literal(PLUGIN_LOCK_VERSION),
  plugins: z.record(z.string().regex(PLUGIN_ID_RE), lockEntrySchema),
}).superRefine((lockfile, ctx) => {
  for (const [id, entry] of Object.entries(lockfile.plugins)) {
    if (id !== entry.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `plugin lock key does not match entry id: ${entry.id}`,
        path: ["plugins", id],
      });
    }
  }
});

export class PluginLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginLockError";
  }
}

export function pluginRootPath(): string {
  return process.env.MCP_DEVICES_PLUGIN_ROOT
    ?? join(homedir(), ".mcp-devices", "plugins");
}

export function pluginLockPath(): string {
  return process.env.MCP_DEVICES_PLUGIN_LOCKFILE
    ?? join(dirname(pluginRootPath()), "plugins.lock");
}

export function emptyPluginLockfile(): PluginLockfile {
  return { version: PLUGIN_LOCK_VERSION, plugins: {} };
}

function validatePathOverride(path: string, label: string): string {
  if (!path || path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new PluginLockError(`Invalid ${label}.`);
  }
  return path;
}

async function processStartToken(pid: number): Promise<string | undefined> {
  // Darwin has no /proc; launch time is the lifetime-bound identity.
  if (process.platform === "darwin") {
    try {
      const result = await execFileAsync(
        "/bin/ps",
        ["-p", String(pid), "-o", "lstart="],
        {
          encoding: "utf8",
          maxBuffer: 4096,
          timeout: 1000,
          windowsHide: true,
        },
      );
      if (typeof result.stdout !== "string") return undefined;
      const token = result.stdout.trim().replace(/\s+/gu, " ");
      return token || undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
    return fields[19] || undefined;
  } catch {
    return undefined;
  }
}

async function currentStateLockOwner(): Promise<StateLockOwner> {
  const token = await processStartToken(process.pid);
  return token
    ? { pid: process.pid, processStartToken: token }
    : { pid: process.pid };
}

async function writeStateLockOwner(lockPath: string): Promise<void> {
  const ownerPath = join(lockPath, STATE_LOCK_OWNER_FILE);
  const owner = await currentStateLockOwner();
  let handle: FileHandle | undefined;
  try {
    handle = await open(ownerPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify(owner), { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sameStateLockOwner(
  left: StateLockOwner | undefined,
  right: StateLockOwner | undefined,
): boolean {
  return Boolean(
    left
    && right
    && left.pid === right.pid
    && left.processStartToken === right.processStartToken,
  );
}

async function replaceStateLockOwner(
  lockPath: string,
  owner: StateLockOwner,
): Promise<void> {
  await writeJsonAtomic(join(lockPath, STATE_LOCK_OWNER_FILE), owner, 0o600);
}


async function readStateLockOwner(lockPath: string): Promise<StateLockOwner | undefined> {
  const ownerPath = join(lockPath, STATE_LOCK_OWNER_FILE);
  let handle: FileHandle | undefined;
  try {
    const details = await lstat(ownerPath);
    if (!details.isFile() || details.isSymbolicLink() || details.size > STATE_LOCK_OWNER_BYTES) {
      return undefined;
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = await open(ownerPath, constants.O_RDONLY | noFollow);
    const openedDetails = await handle.stat();
    if (!openedDetails.isFile() || openedDetails.isSymbolicLink() || openedDetails.size > STATE_LOCK_OWNER_BYTES) {
      return undefined;
    }
    const parsed = stateLockOwnerSchema.safeParse(
      JSON.parse(await handle.readFile("utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}


async function stateLockOwnerIsDead(owner: StateLockOwner): Promise<boolean | undefined> {
  try {
    process.kill(owner.pid, 0);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code !== "EPERM") return undefined;
  }

  // A live PID can be reused; without a lifetime token, fail closed.
  if (!owner.processStartToken) return undefined;
  const currentToken = await processStartToken(owner.pid);
  if (!currentToken) return undefined;
  return currentToken !== owner.processStartToken;
}

async function inspectStateLock(
  lockPath: string,
): Promise<{ readonly owner?: StateLockOwner } | undefined> {
  let details: Stats;
  try {
    details = await lstat(lockPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new PluginLockError("Plugin state lock is not a private directory.");
  }
  return { owner: await readStateLockOwner(lockPath) };
}


async function createStateLockReclaimMarker(lockPath: string): Promise<string> {
  const markerPath = join(
    lockPath,
    `${STATE_LOCK_RECLAIM_PREFIX}${randomUUID()}${STATE_LOCK_RECLAIM_SUFFIX}`,
  );
  const candidatePath = `${markerPath}${STATE_LOCK_CANDIDATE_SUFFIX}`;
  await mkdir(candidatePath, { mode: 0o700 });
  let published = false;
  try {
    await writeStateLockOwner(candidatePath);
    await rename(candidatePath, markerPath);
    published = true;
    await writeJsonAtomic(
      join(markerPath, STATE_LOCK_MARKER_FILE),
      { createdAt: process.hrtime.bigint().toString() },
      0o600,
    );
    return markerPath;
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true }).catch(() => {});
    if (published) await rm(markerPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function readStateLockReclaimMarker(
  markerPath: string,
): Promise<bigint | undefined> {
  const markerFile = join(markerPath, STATE_LOCK_MARKER_FILE);
  let handle: FileHandle | undefined;
  try {
    const details = await lstat(markerFile);
    if (!details.isFile() || details.isSymbolicLink() || details.size > STATE_LOCK_OWNER_BYTES) {
      return undefined;
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = await open(markerFile, constants.O_RDONLY | noFollow);
    const openedDetails = await handle.stat();
    if (!openedDetails.isFile() || openedDetails.isSymbolicLink() || openedDetails.size > STATE_LOCK_OWNER_BYTES) {
      return undefined;
    }
    const parsed = stateLockMarkerSchema.safeParse(
      JSON.parse(await handle.readFile("utf8")),
    );
    return parsed.success ? BigInt(parsed.data.createdAt) : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function inspectStateLockReclaimMarkers(
  lockPath: string,
): Promise<readonly StateLockReclaimMarker[] | undefined> {
  let entries: readonly string[];
  try {
    entries = await readdir(lockPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const markers: StateLockReclaimMarker[] = [];
  for (const entry of entries) {
    if (
      !entry.startsWith(STATE_LOCK_RECLAIM_PREFIX)
      || !entry.endsWith(STATE_LOCK_RECLAIM_SUFFIX)
    ) {
      continue;
    }
    const markerPath = join(lockPath, entry);
    let details: Stats;
    try {
      details = await lstat(markerPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (details.isSymbolicLink() || !details.isDirectory()) return undefined;
    const owner = await readStateLockOwner(markerPath);
    const createdAt = await readStateLockReclaimMarker(markerPath);
    if (!owner) return undefined;
    if (createdAt === undefined) {
      const dead = await stateLockOwnerIsDead(owner);
      if (dead === true) {
        await rm(markerPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      return undefined;
    }
    markers.push({ path: markerPath, owner, createdAt });
  }
  markers.sort((left, right) => (
    left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0
  ));
  if (markers[1] && markers[0].createdAt === markers[1].createdAt) return undefined;
  return markers;
}

async function reclaimStateLock(
  lockPath: string,
  expectedOwner: StateLockOwner,
): Promise<boolean> {
  const current = await inspectStateLock(lockPath);
  if (!sameStateLockOwner(current?.owner, expectedOwner)) return false;

  let markerPath: string;
  try {
    markerPath = await createStateLockReclaimMarker(lockPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  let committed = false;
  try {
    for (;;) {
      const markers = await inspectStateLockReclaimMarkers(lockPath);
      if (!markers) return false;
      let removedDeadMarker = false;
      for (const marker of markers) {
        const dead = await stateLockOwnerIsDead(marker.owner);
        if (dead === true) {
          await rm(marker.path, { recursive: true, force: true }).catch(() => {});
          removedDeadMarker = true;
        } else if (dead !== false) {
          return false;
        }
      }
      if (removedDeadMarker) continue;

      const winner = markers[0];
      if (!winner || winner.path !== markerPath) return false;
      const latest = await inspectStateLock(lockPath);
      if (!sameStateLockOwner(latest?.owner, expectedOwner)) return false;

      const owner = await currentStateLockOwner();
      try {
        await replaceStateLockOwner(lockPath, owner);
      } catch (error) {
        const persisted = await readStateLockOwner(lockPath);
        if (!sameStateLockOwner(persisted, owner)) throw error;
      }
      const persisted = await readStateLockOwner(lockPath);
      if (!sameStateLockOwner(persisted, owner)) {
        throw new PluginLockError("Unable to verify the reclaimed plugin state lock owner.");
      }
      committed = true;
      return true;
    }
  } finally {
    if (!committed) {
      await rm(markerPath, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function createStateLockCandidate(lockPath: string): Promise<string> {
  const candidatePath = join(
    dirname(lockPath),
    `.${basename(lockPath)}.${randomUUID()}${STATE_LOCK_CANDIDATE_SUFFIX}`,
  );
  await mkdir(candidatePath, { mode: 0o700 });
  try {
    await writeStateLockOwner(candidatePath);
    return candidatePath;
  } catch (error) {
    await rm(candidatePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function tryAcquireStateLock(lockPath: string): Promise<boolean> {
  const existing = await inspectStateLock(lockPath);
  if (existing) {
    if (!existing.owner) return false;
    const dead = await stateLockOwnerIsDead(existing.owner);
    if (dead !== true) return false;
    if (!await reclaimStateLock(lockPath, existing.owner)) return false;
    return true;
  }

  const candidatePath = await createStateLockCandidate(lockPath);
  try {
    if (await inspectStateLock(lockPath)) return false;
    await rename(candidatePath, lockPath);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "EISDIR") return false;
    throw error;
  } finally {
    await rm(candidatePath, { recursive: true, force: true }).catch(() => {});
  }
}
/**
 * Serialize plugin state commits across processes. Each acquired lock is
 * published with owner metadata in a fully written candidate directory before
 * the candidate is atomically renamed into place. Stale recovery publishes a
 * fully written, timestamped marker; the oldest live marker owns the
 * owner.json transition and remains until recursive lock release.
 */
export async function withPluginStateLock<T>(
  statePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  validatePathOverride(statePath, "plugin state path");
  const lockPath = `${statePath}.lock`;
  validatePathOverride(lockPath, "plugin state lock path");
  await ensurePrivateDirectory(dirname(statePath));

  const startedAt = Date.now();
  let acquired = false;
  while (!acquired) {
    acquired = await tryAcquireStateLock(lockPath);
    if (acquired) break;
    if (Date.now() - startedAt >= STATE_LOCK_TIMEOUT_MS) {
      throw new PluginLockError("Timed out waiting for the plugin state lock.");
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, STATE_LOCK_RETRY_MS));
  }

  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export async function readPluginLockfile(
  path = pluginLockPath(),
): Promise<PluginLockfile> {
  validatePathOverride(path, "plugin lockfile path");
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new PluginLockError("Plugin lockfile must be a regular file.");
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyPluginLockfile();
    }
    throw error;
  }

  await ensurePrivateDirectory(dirname(path));

  let value: unknown;
  try {
    value = JSON.parse(
      (await readPrivateFile(path, MAX_LOCKFILE_BYTES, "plugin lockfile")).toString("utf8"),
    );
  } catch (error: unknown) {
    if (error instanceof PluginLockError) throw error;
    throw new PluginLockError(
      `Unable to read plugin lockfile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = lockfileSchema.safeParse(value);
  if (!parsed.success) {
    throw new PluginLockError("Plugin lockfile is invalid.");
  }
  return parsed.data as PluginLockfile;
}

export async function writePluginLockfile(
  lockfile: PluginLockfile,
  path = pluginLockPath(),
): Promise<void> {
  validatePathOverride(path, "plugin lockfile path");
  const parsed = lockfileSchema.safeParse(lockfile);
  if (!parsed.success) throw new PluginLockError("Cannot write an invalid plugin lockfile.");
  const plugins = Object.fromEntries(
    Object.entries(parsed.data.plugins).sort(([a], [b]) => a.localeCompare(b)),
  );
  const serialized = { version: PLUGIN_LOCK_VERSION, plugins };
  await ensurePrivateDirectory(dirname(path));
  await writeJsonAtomic(path, serialized, 0o600);
}

export function assertPluginId(id: string): void {
  if (!PLUGIN_ID_RE.test(id)) {
    throw new PluginLockError("Plugin id must match /^[a-z0-9][a-z0-9._-]*$/.");
  }
}

export function entryRelativePath(packageDir: string, entry: string): string {
  const root = resolve(packageDir);
  const resolvedEntry = resolve(packageDir, entry);
  if (resolvedEntry !== root && !resolvedEntry.startsWith(root + sep)) {
    throw new PluginLockError("Plugin entry escapes its package directory.");
  }
  return relative(root, resolvedEntry).split(sep).join("/");
}

export async function hashPluginDirectory(directory: string): Promise<`sha256-${string}`> {
  const root = resolve(directory);
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new PluginLockError("Plugin directory must be a real directory.");
  }

  const hash = createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;

  async function visit(current: string): Promise<void> {
    const directoryHandle = await opendir(current);
    const entries = [] as Array<{
      name: string;
      isDirectory: boolean;
      isFile: boolean;
      isSymbolicLink: boolean;
    }>;
    for await (const entry of directoryHandle) {
      if (entries.length >= MAX_PLUGIN_FILES * 2) {
        throw new PluginLockError("Plugin contains too many directory entries.");
      }
      entries.push({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        isSymbolicLink: entry.isSymbolicLink(),
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      if (entry.isSymbolicLink) {
        throw new PluginLockError(`Plugin contains a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory) {
        hash.update(`D\\0${relativePath}\\0`, "utf8");
        await visit(absolute);
        continue;
      }
      if (!entry.isFile) {
        throw new PluginLockError(`Plugin contains an unsupported filesystem entry: ${relativePath}`);
      }
      fileCount += 1;
      if (fileCount > MAX_PLUGIN_FILES) {
        throw new PluginLockError(`Plugin exceeds the ${MAX_PLUGIN_FILES}-file limit.`);
      }
      let handle: FileHandle | undefined;
      try {
        handle = await open(absolute, constants.O_RDONLY | noFollow);
        const fileDetails = await handle.stat();
        if (!fileDetails.isFile() || fileDetails.isSymbolicLink()) {
          throw new PluginLockError(`Plugin contains a non-regular file: ${relativePath}`);
        }
        const fileBytes = fileDetails.size;
        if (!Number.isSafeInteger(fileBytes) || fileBytes > MAX_PLUGIN_BYTES) {
          throw new PluginLockError(`Plugin exceeds the ${MAX_PLUGIN_BYTES}-byte limit.`);
        }
        totalBytes += fileBytes;
        if (totalBytes > MAX_PLUGIN_BYTES) {
          throw new PluginLockError(`Plugin exceeds the ${MAX_PLUGIN_BYTES}-byte limit.`);
        }
        hash.update(`F\\0${relativePath}\\0${fileBytes}\\0`, "utf8");

        let readBytes = 0;
        while (readBytes < fileBytes) {
          const chunkLength = Math.min(64 * 1024, fileBytes - readBytes);
          const buffer = Buffer.allocUnsafe(chunkLength);
          const result = await handle.read(buffer, 0, chunkLength, readBytes);
          if (result.bytesRead === 0) break;
          readBytes += result.bytesRead;
          hash.update(buffer.subarray(0, result.bytesRead));
        }
        const finalDetails = await handle.stat();
        if (readBytes !== fileBytes || finalDetails.size !== fileBytes) {
          throw new PluginLockError(`Plugin changed while it was being hashed: ${relativePath}`);
        }
      } catch (error: unknown) {
        if (error instanceof PluginLockError) throw error;
        throw new PluginLockError(
          `Unable to hash plugin file ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await handle?.close().catch(() => {});
      }
    }
  }

  await visit(root);
  return `sha256-${hash.digest("hex")}`;
}

export interface PluginDirectorySnapshot {
  readonly directory: string;
  readonly integrity: `sha256-${string}`;
  readonly bytes: number;
}

/**
 * Copy a plugin tree into a private snapshot while preserving its bytes.
 *
 * The returned directory is independent of the caller-controlled source tree.
 * Every file is copied through an opened handle, then the snapshot itself is
 * hashed before its files are made read-only. Callers MUST import only from
 * the returned directory when they rely on the returned integrity.
 */
export async function snapshotPluginDirectory(
  directory: string,
  parent: string,
  maxBytes = MAX_PLUGIN_BYTES,
): Promise<PluginDirectorySnapshot> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new PluginLockError("Plugin snapshot byte budget must be a positive safe integer.");
  }
  const byteLimit = Math.min(maxBytes, MAX_PLUGIN_BYTES);
  const root = resolve(directory);
  prepareSnapshotParent(parent);
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new PluginLockError("Plugin directory must be a real directory.");
  }

  const snapshot = await mkdtemp(join(parent, SNAPSHOT_PREFIX));
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let fileCount = 0;
  let totalBytes = 0;
  let committed = false;

  async function copyDirectory(current: string, destination: string): Promise<void> {
    const currentDetails = await lstat(current);
    if (!currentDetails.isDirectory() || currentDetails.isSymbolicLink()) {
      throw new PluginLockError("Plugin directory changed while it was being snapshotted.");
    }
    await mkdir(destination, { recursive: true, mode: 0o700 });

    const directoryHandle = await opendir(current);
    const entries: Array<{
      name: string;
      isDirectory: boolean;
      isFile: boolean;
      isSymbolicLink: boolean;
    }> = [];
    try {
      for await (const entry of directoryHandle) {
        if (entries.length >= MAX_PLUGIN_FILES * 2) {
          throw new PluginLockError("Plugin contains too many directory entries.");
        }
        entries.push({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          isSymbolicLink: entry.isSymbolicLink(),
        });
      }
    } finally {
      await directoryHandle.close().catch(() => {});
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const sourcePath = join(current, entry.name);
      const destinationPath = join(destination, entry.name);
      const details = await lstat(sourcePath);
      if (details.isSymbolicLink() || entry.isSymbolicLink) {
        throw new PluginLockError(`Plugin contains a symbolic link: ${entry.name}`);
      }
      if (details.isDirectory()) {
        await copyDirectory(sourcePath, destinationPath);
        continue;
      }
      if (!details.isFile() || !entry.isFile) {
        throw new PluginLockError(`Plugin contains an unsupported filesystem entry: ${entry.name}`);
      }

      fileCount += 1;
      if (fileCount > MAX_PLUGIN_FILES) {
        throw new PluginLockError(`Plugin exceeds the ${MAX_PLUGIN_FILES}-file limit.`);
      }
      const fileBytes = details.size;
      if (!Number.isSafeInteger(fileBytes) || fileBytes > byteLimit) {
        throw new PluginLockError(`Plugin exceeds the ${byteLimit}-byte snapshot limit.`);
      }
      totalBytes += fileBytes;
      if (totalBytes > byteLimit) {
        throw new PluginLockError(`Plugin exceeds the ${byteLimit}-byte snapshot limit.`);
      }

      let sourceHandle: FileHandle | undefined;
      let destinationHandle: FileHandle | undefined;
      try {
        sourceHandle = await open(sourcePath, constants.O_RDONLY | noFollow);
        const openedDetails = await sourceHandle.stat();
        if (
          !openedDetails.isFile()
          || openedDetails.isSymbolicLink()
          || openedDetails.size !== fileBytes
        ) {
          throw new PluginLockError(`Plugin changed while it was being snapshotted: ${entry.name}`);
        }
        destinationHandle = await open(
          destinationPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
          0o600 | (details.mode & 0o111),
        );
        let readBytes = 0;
        while (readBytes < fileBytes) {
          const chunkLength = Math.min(64 * 1024, fileBytes - readBytes);
          const buffer = Buffer.allocUnsafe(chunkLength);
          const result = await sourceHandle.read(buffer, 0, chunkLength, readBytes);
          if (result.bytesRead === 0) break;
          let written = 0;
          while (written < result.bytesRead) {
            const writeResult = await destinationHandle.write(
              buffer.subarray(written, result.bytesRead),
            );
            if (writeResult.bytesWritten === 0) {
              throw new PluginLockError(`Unable to snapshot plugin file: ${entry.name}`);
            }
            written += writeResult.bytesWritten;
          }
          readBytes += result.bytesRead;
        }
        const finalDetails = await sourceHandle.stat();
        if (readBytes !== fileBytes || finalDetails.size !== fileBytes) {
          throw new PluginLockError(`Plugin changed while it was being snapshotted: ${entry.name}`);
        }
        await destinationHandle.sync();
      } catch (error: unknown) {
        if (error instanceof PluginLockError) throw error;
        throw new PluginLockError(
          `Unable to snapshot plugin file ${entry.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        await destinationHandle?.close().catch(() => {});
        await sourceHandle?.close().catch(() => {});
      }
    }
  }

  async function protectSnapshotFiles(current: string): Promise<void> {
    const directoryHandle = await opendir(current);
    const entries: string[] = [];
    try {
      for await (const entry of directoryHandle) entries.push(entry.name);
    } finally {
      await directoryHandle.close().catch(() => {});
    }
    for (const name of entries) {
      const path = join(current, name);
      const details = await lstat(path);
      if (details.isDirectory() && !details.isSymbolicLink()) {
        await protectSnapshotFiles(path);
      } else if (details.isFile() && !details.isSymbolicLink()) {
        await chmod(path, 0o400 | (details.mode & 0o111));
      } else {
        throw new PluginLockError(`Plugin snapshot contains an unsupported filesystem entry: ${name}`);
      }
    }
  }

  try {
    await copyDirectory(root, snapshot);
    const integrity = await hashPluginDirectory(snapshot);
    await protectSnapshotFiles(snapshot);
    committed = true;
    return { directory: snapshot, integrity, bytes: totalBytes };
  } finally {
    if (!committed) {
      await rm(snapshot, { recursive: true, force: true }).catch(() => {});
    }
  }
}