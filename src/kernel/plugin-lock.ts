import { createHash } from "node:crypto";
import { lstat, opendir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import { z } from "zod";
import type { PluginPermission } from "@mcp-devices/plugin-api";
import { writeJsonAtomic } from "../utils/json-file.js";
import {
  ensurePrivateDirectory,
  readPrivateFile,
} from "../utils/private-storage.js";

export const PLUGIN_LOCK_VERSION = 1 as const;

const MAX_LOCKFILE_BYTES = 1024 * 1024;
const MAX_PLUGIN_FILES = 8192;
const MAX_PLUGIN_BYTES = 256 * 1024 * 1024;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]+$/;
const INTEGRITY_RE = /^sha256-[a-f0-9]{64}$/;

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

  async function visit(current: string): Promise<void> {
    const directoryHandle = await opendir(current);
    const entries = [] as Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }>;
    for await (const entry of directoryHandle) {
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
      const data = await readFile(absolute);
      totalBytes += data.byteLength;
      if (totalBytes > MAX_PLUGIN_BYTES) {
        throw new PluginLockError(`Plugin exceeds the ${MAX_PLUGIN_BYTES}-byte limit.`);
      }
      hash.update(`F\\0${relativePath}\\0${data.byteLength}\\0`, "utf8");
      hash.update(data);
    }
  }

  await visit(root);
  return `sha256-${hash.digest("hex")}`;
}