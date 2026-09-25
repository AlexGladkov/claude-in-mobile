import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensurePrivateDirectory, ensurePrivateDirectorySync } from "./private-storage.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private storage directories", () => {
  it("does not change an existing safe parent when creating a private child", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "mcp-private-storage-parent-"));
    tempRoots.push(root);
    await chmod(root, 0o755);
    const before = (await lstat(root)).mode;

    await ensurePrivateDirectory(join(root, "private"));

    expect((await lstat(root)).mode).toBe(before);
    expect((await lstat(join(root, "private"))).mode & 0o777).toBe(0o700);
  });
  it("does not change an existing safe parent in the synchronous helper", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "mcp-private-storage-sync-"));
    tempRoots.push(root);
    await chmod(root, 0o755);
    const before = (await lstat(root)).mode;

    ensurePrivateDirectorySync(join(root, "private"));

    expect((await lstat(root)).mode).toBe(before);
    expect((await lstat(join(root, "private"))).mode & 0o777).toBe(0o700);
  });

  it("tightens permissions on existing private directories", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "mcp-private-storage-existing-"));
    tempRoots.push(root);
    const asyncPath = join(root, "existing-async");
    const syncPath = join(root, "existing-sync");
    await mkdir(asyncPath, { mode: 0o755 });
    await mkdir(syncPath, { mode: 0o755 });
    await chmod(asyncPath, 0o755);
    await chmod(syncPath, 0o755);

    await ensurePrivateDirectory(asyncPath);
    ensurePrivateDirectorySync(syncPath);

    expect((await lstat(asyncPath)).mode & 0o777).toBe(0o700);
    expect((await lstat(syncPath)).mode & 0o777).toBe(0o700);
  });

  it("rejects a shared writable parent without changing its permissions", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "mcp-private-storage-unsafe-"));
    tempRoots.push(root);
    await chmod(root, 0o777);
    const before = (await lstat(root)).mode;

    await expect(ensurePrivateDirectory(join(root, "private"))).rejects.toMatchObject({
      code: "STORAGE_CORRUPTED",
    });
    expect((await lstat(root)).mode).toBe(before);
  });
});
