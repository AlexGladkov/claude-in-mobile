import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { chmod, lstat, mkdir, open, opendir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MobileError } from "../errors.js";

const DIR_MODE = 0o700;
const SAFE_NAMESPACE = /^[a-z0-9][a-z0-9-]*$/;

export function privateRuntimeDir(namespace: string): string {
  validateNamespace(namespace);
  const root = join(homedir(), ".cache", "mcp-devices", namespace);
  assertExistingDirectory(nearestExistingPathSync(root));
  mkdirSync(root, { recursive: true, mode: DIR_MODE });
  const metadata = lstatSync(root);
  assertExistingDirectory({ path: root, metadata });
  chmodSync(root, DIR_MODE);
  return root;
}

export function makePrivateTempDir(namespace: string): string {
  validateNamespace(namespace);
  const root = mkdtempSync(join(tmpdir(), `${namespace}-`));
  chmodSync(root, DIR_MODE);
  return root;
}
export function ensurePrivateDirectorySync(path: string): void {
  assertExistingDirectory(nearestExistingPathSync(path));
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  const metadata = lstatSync(path);
  assertExistingDirectory({ path, metadata });
  chmodSync(path, DIR_MODE);
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  assertExistingDirectory(await nearestExistingPath(path));
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  const metadata = await lstat(path);
  assertExistingDirectory({ path, metadata });
  await chmod(path, DIR_MODE);
}

type ExistingPath = Readonly<{
  path: string;
  metadata: Stats;
}>;

function assertExistingDirectory(existing: ExistingPath): void {
  const { path, metadata } = existing;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new MobileError(
      `Private storage path "${path}" is not a real directory.`,
      "STORAGE_CORRUPTED",
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && metadata.uid !== uid) {
    throw new MobileError(
      `Private storage path "${path}" is not owned by the current user.`,
      "STORAGE_CORRUPTED",
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o022) !== 0) {
    throw new MobileError(
      `Private storage path "${path}" is writable by another user.`,
      "STORAGE_CORRUPTED",
    );
  }
}

function nearestExistingPathSync(path: string): ExistingPath {
  let candidate = path;
  for (;;) {
    try {
      return { path: candidate, metadata: lstatSync(candidate) };
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function nearestExistingPath(path: string): Promise<ExistingPath> {
  let candidate = path;
  for (;;) {
    try {
      return { path: candidate, metadata: await lstat(candidate) };
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

export async function readPrivateDirectory(
  path: string,
  maxEntries: number,
): Promise<ReadonlyArray<Dirent>> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error("maxEntries must be a positive safe integer.");
  }
  const directory = await opendir(path);
  const entries: Dirent[] = [];
  for await (const entry of directory) {
    if (entries.length >= maxEntries) {
      throw new MobileError(
        `Private storage directory exceeds the ${maxEntries}-entry limit.`,
        "STORAGE_LIMIT_EXCEEDED",
      );
    }
    entries.push(entry);
  }
  return entries;
}

export async function readPrivateFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer.");
  }
  let handle: FileHandle | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new MobileError(
        `${label} is invalid or exceeds the ${maxBytes}-byte limit.`,
        "STORAGE_CORRUPTED",
      );
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof MobileError) throw error;
    throw new MobileError(`Unable to read ${label}.`, "STORAGE_READ_FAILED");
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function readPrivateFileSync(
  path: string,
  maxBytes: number,
  label: string,
): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive safe integer.");
  }
  let fd: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    fd = openSync(path, constants.O_RDONLY | noFollow);
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new MobileError(
        `${label} is invalid or exceeds the ${maxBytes}-byte limit.`,
        "STORAGE_CORRUPTED",
      );
    }
    return readFileSync(fd);
  } catch (error) {
    if (error instanceof MobileError) throw error;
    throw new MobileError(`Unable to read ${label}.`, "STORAGE_READ_FAILED");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}


function validateNamespace(namespace: string): void {
  if (!SAFE_NAMESPACE.test(namespace)) {
    throw new Error(`Invalid private storage namespace: ${namespace}`);
  }
}
