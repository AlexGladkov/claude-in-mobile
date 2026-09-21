import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MobileError } from "../errors.js";
const MAX_JSON_FILE_BYTES = 16 * 1024 * 1024;

export async function readJsonOrDefault(
  path: string,
  createDefault: () => unknown,
  label: string,
  maxBytes = MAX_JSON_FILE_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_JSON_FILE_BYTES) {
    throw new Error(`Invalid JSON size limit: ${maxBytes}`);
  }
  let handle: FileHandle;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return createDefault();
    throw new MobileError(`Unable to read ${label}.`, "STORAGE_READ_FAILED");
  }

  let data: string;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) {
      throw new MobileError(`${label} is invalid or exceeds the size limit.`, "STORAGE_CORRUPTED");
    }
    data = await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof MobileError) throw error;
    throw new MobileError(`Unable to read ${label}.`, "STORAGE_READ_FAILED");
  } finally {
    await handle.close().catch(() => {});
  }

  try {
    return JSON.parse(data);
  } catch {
    throw new MobileError(
      `${label} is corrupted: invalid JSON. Restore or remove it before writing new data.`,
      "STORAGE_CORRUPTED",
    );
  }
}

export async function writeFileAtomic(
  path: string,
  data: string | NodeJS.ArrayBufferView,
  mode = 0o600,
): Promise<void> {
  const byteLength = typeof data === "string"
    ? Buffer.byteLength(data, "utf8")
    : data.byteLength;
  if (byteLength > MAX_JSON_FILE_BYTES) {
    throw new MobileError("Storage payload exceeds the size limit.", "STORAGE_WRITE_FAILED");
  }
  const partialPath = join(dirname(path), `.${randomUUID()}.partial`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(partialPath, "wx", mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(partialPath, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(partialPath).catch(() => {});
    throw error;
  }
}

export function writeJsonAtomic(
  path: string,
  value: unknown,
  mode = 0o600,
): Promise<void> {
  return writeFileAtomic(path, JSON.stringify(value, null, 2), mode);
}
