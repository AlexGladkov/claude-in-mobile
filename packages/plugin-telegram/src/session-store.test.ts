import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir, platform as osPlatform } from "node:os";
import { join } from "node:path";

import {
  SessionStore,
  TelegramSessionError,
  validateSessionName,
} from "./session-store.js";

/**
 * T1 security coverage: StringSessions live home-only with 0o700/0o600 and are
 * path-contained. Tests use a tmp base dir (the only sanctioned way to avoid
 * touching the real home directory) -- production code never passes baseDir.
 */

describe("SessionStore (T1)", () => {
  let base: string;
  let store: SessionStore;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "cim-tg-session-"));
    store = new SessionStore(base);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("defaults to a home directory, never the project tree (cwd)", () => {
    const homeStore = new SessionStore();
    expect(homeStore.getBaseDir()).toContain(".mcp-devices");
    expect(homeStore.getBaseDir()).not.toContain(process.cwd());
  });

  it("persists and reloads a StringSession round-trip", async () => {
    await store.save("test-dc-smoke", "MY_SECRET_SESSION");
    expect(await store.exists("test-dc-smoke")).toBe(true);
    expect(await store.load("test-dc-smoke")).toBe("MY_SECRET_SESSION");
  });

  const describeUnix = osPlatform() === "win32" ? describe.skip : describe;
  describeUnix("file permissions", () => {
    it("writes the session file 0o600 and its dir 0o700", async () => {
      await store.save("test-dc-smoke", "SECRET");
      const fileMode = statSync(join(base, "test-dc-smoke", "session")).mode & 0o777;
      const dirMode = statSync(join(base, "test-dc-smoke")).mode & 0o777;
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    });
  });

  it("returns null for an unknown session", async () => {
    expect(await store.load("does-not-exist")).toBeNull();
    expect(await store.exists("does-not-exist")).toBe(false);
  });

  it("rejects path-traversal and malformed session names", () => {
    expect(() => validateSessionName("../escape")).toThrow(TelegramSessionError);
    expect(() => validateSessionName("a/b")).toThrow(TelegramSessionError);
    expect(() => validateSessionName("")).toThrow(TelegramSessionError);
    expect(() => validateSessionName("ok-name_1.2")).not.toThrow();
  });

  it("blocks save() with a traversal name before any I/O", async () => {
    await expect(store.save("../../evil", "x")).rejects.toThrow(
      TelegramSessionError,
    );
  });

  it("deletes a stored session", async () => {
    await store.save("test-dc-smoke", "SECRET");
    await store.delete("test-dc-smoke");
    expect(await store.exists("test-dc-smoke")).toBe(false);
  });
});
