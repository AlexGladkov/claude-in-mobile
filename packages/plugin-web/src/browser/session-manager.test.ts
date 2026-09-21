import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_BROWSER_SESSIONS, SessionManager } from "./session-manager.js";

interface SessionManagerHarness {
  isProcessAlive(pid: number): boolean;
  readProcessCommand(pid: number): string;
  lockPath(session: string): string;
}

const roots: string[] = [];

function manager(): SessionManager {
  const root = mkdtempSync(join(tmpdir(), "mcp-browser-lock-"));
  roots.push(root);
  return new SessionManager(root);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SessionManager profile ownership", () => {
  it("atomically refuses a live foreign owner and releases only its token", () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-browser-lock-"));
    roots.push(root);
    const first = new SessionManager(root);
    const second = new SessionManager(root);
    const token = first.acquireLock("shared");

    expect(() => second.acquireLock("shared")).toThrow(`live PID ${process.pid}`);
    first.releaseLock("shared", "wrong-token");
    expect(() => second.acquireLock("shared")).toThrow(`live PID ${process.pid}`);

    first.releaseLock("shared", token);
    const secondToken = second.acquireLock("shared");
    second.releaseLock("shared", secondToken);
  });

  it("preserves legacy-safe profile names and bounds hashed components", () => {
    const sessions = manager();

    expect(sessions.getProfileDir("default")).toBe(join(sessions.profileBaseDir, "default"));
    expect(sessions.getProfileDir("qa.user")).toBe(join(sessions.profileBaseDir, "qa.user"));
    expect(basename(sessions.getProfileDir("a".repeat(256))).length).toBeLessThanOrEqual(64);
  });

  it("honors a live lock written as a legacy plain pid", () => {
    const sessions = manager();
    const lockPath = join(sessions.getProfileDir("legacy"), ".lock");
    writeFileSync(lockPath, String(process.pid));

    expect(() => sessions.acquireLock("legacy")).toThrow(`live PID ${process.pid}`);
  });

  it("honors a live legacy lock for a formerly sanitized session name", () => {
    const sessions = manager();
    const legacyProfile = join(sessions.profileBaseDir, "a_b");
    writeFileSync(
      join(sessions.getProfileDir("a_b"), ".lock"),
      String(process.pid),
    );
    expect(legacyProfile).toBe(sessions.getProfileDir("a_b"));

    expect(() => sessions.acquireLock("a/b")).toThrow(`live PID ${process.pid}`);
  });

  it("honors the exact legacy double-dot sanitizer", () => {
    const sessions = manager();
    const legacyProfile = join(sessions.profileBaseDir, "a__b");
    mkdirSync(legacyProfile, { recursive: true });
    writeFileSync(join(legacyProfile, ".lock"), String(process.pid));

    expect(() => sessions.acquireLock("a..b")).toThrow(`live PID ${process.pid}`);
  });

  it("recovers a dead stale lock", () => {
    const sessions = manager();
    const lockPath = join(sessions.getProfileDir("stale"), ".lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "stale" }));

    const token = sessions.acquireLock("stale");

    expect(token).not.toBe("stale");
    sessions.releaseLock("stale", token);
  });
  it.skipIf(process.platform === "win32")(
    "replaces a symlinked pid record without overwriting its target",
    () => {
      const sessions = manager();
      const token = sessions.acquireLock("pid-symlink");
      const pidPath = join(sessions.getProfileDir("pid-symlink"), ".chrome-pid");
      const targetPath = join(sessions.profileBaseDir, "pid-target");
      writeFileSync(targetPath, "untouched");
      symlinkSync(targetPath, pidPath);

      sessions.writePidFile("pid-symlink", 99_999, token);

      expect(readFileSync(targetPath, "utf8")).toBe("untouched");
      expect(sessions.readPidFile("pid-symlink")).toEqual({ pid: 99_999, token });
      sessions.releaseLock("pid-symlink", token);
    },
  );



  it("recovers a reclaim directory stranded by a crashed process", () => {
    const sessions = manager();
    const sessionsHarness = sessions as unknown as SessionManagerHarness;
    const lockPath = sessionsHarness.lockPath("stranded");
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "stale" }));
    mkdirSync(`${lockPath}.reclaim`);

    const token = sessions.acquireLock("stranded");

    sessions.releaseLock("stranded", token);
  });
  it("uses collision-free profile keys", () => {
    const sessions = manager();

    expect(sessions.getProfileDir("a/b")).not.toBe(sessions.getProfileDir("a_b"));
  });

  it("refuses a Chrome profile argument that only shares the expected prefix", () => {
    const sessions = manager();
    const token = sessions.acquireLock("profile");
    sessions.writePidFile("profile", 99_999, token);
    const profileDir = sessions.getProfileDir("profile");
    const harness = sessions as unknown as SessionManagerHarness;
    harness.isProcessAlive = () => true;
    harness.readProcessCommand = () =>
      `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${profileDir}-other`;
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(() => sessions.cleanupOrphanChrome("profile")).toThrow("Refusing to kill");
    expect(kill).not.toHaveBeenCalled();

    sessions.removePidFile("profile", token);
    sessions.releaseLock("profile", token);
  });

  it("counts in-flight claims against the session cap", () => {
    const sessions = manager();
    const tokens: string[] = [];
    for (let index = 0; index < MAX_BROWSER_SESSIONS; index++) {
      tokens.push(sessions.acquireLock(`session-${index}`));
    }

    expect(() => sessions.acquireLock("overflow")).toThrow("session limit reached");

    for (let index = 0; index < tokens.length; index++) {
      sessions.releaseLock(`session-${index}`, tokens[index]!);
    }
  });

  it("rejects invalid Chrome pids before persisting them", () => {
    const sessions = manager();
    const token = sessions.acquireLock("invalid-pid");

    expect(() => sessions.writePidFile("invalid-pid", 1, token)).toThrow("invalid pid");

    sessions.releaseLock("invalid-pid", token);
  });
});
