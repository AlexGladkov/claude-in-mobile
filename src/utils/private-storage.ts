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
import type { Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, opendir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { MobileError } from "../errors.js";

const DIR_MODE = 0o700;
const SAFE_NAMESPACE = /^[a-z0-9][a-z0-9-]*$/;

export function privateRuntimeDir(namespace: string): string {
  validateNamespace(namespace);
  const root = join(homedir(), ".cache", "mcp-devices", namespace);
  mkdirSync(root, { recursive: true, mode: DIR_MODE });
  const metadata = lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new MobileError("Private runtime path is not a real directory.", "STORAGE_CORRUPTED");
  }
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
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new MobileError("Private storage path is not a real directory.", "STORAGE_CORRUPTED");
  }
  chmodSync(path, DIR_MODE);
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new MobileError("Private storage path is not a real directory.", "STORAGE_CORRUPTED");
  }
  await chmod(path, DIR_MODE);
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
