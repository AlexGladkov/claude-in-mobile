import { createHash, randomUUID } from "crypto";
import { execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import {
  existsSync,
  linkSync,
  opendirSync,
  mkdirSync,
  rmdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import {
  ensurePrivateDirectorySync,
  readPrivateFileSync,
} from "mcp-devices/utils/private-storage";
import { sanitizeErrorMessage } from "mcp-devices/utils/sanitize";
import type { BrowserSession } from "./types.js";
import { DEFAULT_SESSION } from "./types.js";
import { z } from "zod";

interface LockRecord {
  pid: number;
  token: string;
}

type PidRecord = LockRecord;

export const MAX_BROWSER_SESSIONS = 8;
const MAX_LOCK_FILE_BYTES = 64 * 1024;
const MAX_RECLAIM_ENTRIES = 64;
const lockRecordSchema = z.object({
  pid: z.number().int().safe().gt(1),
  token: z.string().min(1).max(128),
}).strict();

export class SessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly lockTokens = new Map<string, string>();
  private readonly claims = new Set<string>();
  readonly profileBaseDir: string;

  constructor(profileBaseDir = join(homedir(), ".mcp-devices", "browser-profiles")) {
    this.profileBaseDir = profileBaseDir;
  }

  sanitizeSessionName(name: string): string {
    const legacyName = this.legacySessionName(name);
    if (name === legacyName && legacyName !== "." && legacyName !== "..") return legacyName;
    const readable = legacyName.slice(0, 32);
    const digest = createHash("sha256").update(name).digest("hex").slice(0, 20);
    return `${readable}-${digest}`;
  }

  getProfileDir(session: string): string {
    ensurePrivateDirectorySync(this.profileBaseDir);
    const profileDir = this.profilePath(session);
    ensurePrivateDirectorySync(profileDir);
    return profileDir;
  }

  getSession(name?: string): BrowserSession | undefined {
    return this.sessions.get(name ?? DEFAULT_SESSION);
  }

  hasSession(name?: string): boolean {
    return this.sessions.has(name ?? DEFAULT_SESSION);
  }

  setSession(name: string, session: BrowserSession, token: string): void {
    if (this.lockTokens.get(name) !== token || !this.claims.has(name)) {
      throw new Error(`Browser session "${name}" is not owned by this manager`);
    }
    this.claims.delete(name);
    this.sessions.set(name, session);
  }

  removeSession(name: string): void {
    this.sessions.delete(name);
    this.claims.delete(name);
  }

  listSessions(): string[] {
    return [...this.sessions.keys()];
  }

  acquireLock(session: string): string {
    if (this.claims.has(session) || this.sessions.has(session) || this.lockTokens.has(session)) {
      throw new Error(`Browser session "${session}" is already owned by this process`);
    }
    if (this.sessions.size + this.claims.size >= MAX_BROWSER_SESSIONS) {
      throw new Error(`Browser session limit reached (${MAX_BROWSER_SESSIONS})`);
    }

    this.getProfileDir(session);
    const token = randomUUID();
    const lockPath = this.lockPath(session);
    this.claimPrimaryLock(session, lockPath, token);
    try {
      this.claimLegacyLock(session);
    } catch (error) {
      this.removePrimaryLock(lockPath, token);
      throw error;
    }
    this.lockTokens.set(session, token);
    this.claims.add(session);
    return token;
  }

  releaseLock(session: string, token: string): void {
    if (this.lockTokens.get(session) !== token) return;
    this.removePrimaryLock(this.lockPath(session), token);
    const legacyPath = join(this.profilePath(session), ".lock");
    if (this.readFile(legacyPath)?.trim() === String(process.pid)) {
      try { unlinkSync(legacyPath); } catch {}
    }
    this.lockTokens.delete(session);
    this.claims.delete(session);
  }

  ownsLock(session: string, token: string): boolean {
    return this.lockTokens.get(session) === token;
  }

  writePidFile(session: string, pid: number, token: string): void {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error(`Chrome returned invalid pid: ${pid}`);
    }
    if (!this.ownsLock(session, token)) {
      throw new Error(`Cannot write Chrome pid for unowned session "${session}"`);
    }
    const pidPath = join(this.getProfileDir(session), ".chrome-pid");
    const candidatePath = `${pidPath}.${process.pid}.${token}`;
    try {
      writeFileSync(
        candidatePath,
        JSON.stringify({ pid, token } satisfies PidRecord),
        { flag: "wx", mode: 0o600 },
      );
      renameSync(candidatePath, pidPath);
    } finally {
      try { unlinkSync(candidatePath); } catch {}
    }
  }

  readPidFile(session: string): PidRecord | null {
    return this.parseLock(this.readFile(join(this.getProfileDir(session), ".chrome-pid")));
  }

  removePidFile(session: string, token: string): void {
    const pidPath = join(this.getProfileDir(session), ".chrome-pid");
    const record = this.readPidFile(session);
    if (record?.token !== token && record?.token !== "legacy") return;
    try { unlinkSync(pidPath); } catch {}
  }

  cleanupOrphanChrome(session: string): void {
    const record = this.readPidFile(session);
    if (!record || record.pid <= 1) return;
    const profileDir = this.getProfileDir(session);
    if (!this.isProcessAlive(record.pid)) {
      try { unlinkSync(join(profileDir, ".chrome-pid")); } catch {}
      return;
    }
    const command = this.readProcessCommand(record.pid);
    const exactProfileFlag = `--user-data-dir=${profileDir}`;
    const isChrome = /(?:^|[/\\\s])(Google Chrome|chrome|chromium)(?:\s|$)/i.test(command);
    if (!isChrome || !this.hasExactArgument(command, exactProfileFlag)) {
      throw new Error(
        `Refusing to kill PID ${record.pid}: it is not Chrome for browser session "${session}"`,
      );
    }
    process.kill(record.pid, "SIGTERM");
    console.error(
      `[browser] Killed orphaned Chrome PID ${record.pid} for session "${sanitizeErrorMessage(session)}"`,
    );
    try { unlinkSync(join(profileDir, ".chrome-pid")); } catch {}
  }


  private profilePath(session: string): string {
    return join(this.profileBaseDir, this.sanitizeSessionName(session));
  }

  private legacyProfilePath(session: string): string {
    return join(this.profileBaseDir, this.legacySessionName(session));
  }

  private legacySessionName(session: string): string {
    return (
      session
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/\.\./g, "__")
        .slice(0, 64)
      || "default"
    );
  }

  private lockPath(session: string): string {
    const lockDir = join(this.profileBaseDir, ".locks");
    ensurePrivateDirectorySync(lockDir);
    const lockName = createHash("sha256").update(session).digest("hex");
    return join(lockDir, `${lockName}.lock`);
  }

  private claimPrimaryLock(session: string, lockPath: string, token: string): void {
    const candidatePath = `${lockPath}.${process.pid}.${token}`;
    const reclaimPath = `${lockPath}.reclaim`;
    writeFileSync(
      candidatePath,
      JSON.stringify({ pid: process.pid, token } satisfies LockRecord),
      { flag: "wx", mode: 0o600 },
    );
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          linkSync(candidatePath, lockPath);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") throw error;
        }

        const observed = this.readFile(lockPath);
        const owner = this.parseLock(observed);
        if (owner && this.isProcessAlive(owner.pid)) {
          throw new Error(
            `Browser profile for session "${session}" is owned by live PID ${owner.pid}`,
          );
        }

        const releaseReclaim = this.acquireReclaim(session, reclaimPath, token);
        try {
          const confirmed = this.readFile(lockPath);
          if (confirmed !== observed) continue;
          const confirmedOwner = this.parseLock(confirmed);
          if (confirmedOwner && this.isProcessAlive(confirmedOwner.pid)) {
            throw new Error(
              `Browser profile for session "${session}" is owned by live PID ${confirmedOwner.pid}`,
            );
          }
          try {
            unlinkSync(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          try {
            linkSync(candidatePath, lockPath);
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        } finally {
          releaseReclaim();
        }
      }
      throw new Error(`Could not claim browser profile for session "${session}"`);
    } finally {
      try { unlinkSync(candidatePath); } catch {}
    }
  }

  private acquireReclaim(
    session: string,
    reclaimPath: string,
    token: string,
  ): () => void {
    const ownerName = `owner-${process.pid}-${token}`;
    const ownerPath = join(reclaimPath, ownerName);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        mkdirSync(reclaimPath, { mode: 0o700 });
        try {
          writeFileSync(ownerPath, "", { flag: "wx", mode: 0o600 });
        } catch {
          try { rmdirSync(reclaimPath); } catch {}
          continue;
        }
        return () => {
          try { unlinkSync(ownerPath); } catch {}
          try { rmdirSync(reclaimPath); } catch {}
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const entries: string[] = [];
      try {
        const directory = opendirSync(reclaimPath);
        try {
          let entry;
          while ((entry = directory.readSync()) !== null) {
            if (entries.length >= MAX_RECLAIM_ENTRIES) {
              throw new Error(
                `Browser profile recovery directory exceeds ${MAX_RECLAIM_ENTRIES} entries`,
              );
            }
            entries.push(entry.name);
          }
        } finally {
          directory.closeSync();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const match = /^owner-(\d+)-/.exec(entry);
        const pid = match ? Number(match[1]) : 0;
        if (pid > 1 && this.isProcessAlive(pid)) {
          throw new Error(
            `Browser profile recovery for session "${session}" is owned by live PID ${pid}`,
          );
        }
      }

      let changed = false;
      for (const entry of entries) {
        try {
          unlinkSync(join(reclaimPath, entry));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            changed = true;
            break;
          }
          throw error;
        }
      }
      if (changed) continue;
      try {
        rmdirSync(reclaimPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTEMPTY") continue;
        throw error;
      }
    }
    throw new Error(`Could not recover browser profile lock for session "${session}"`);
  }

  private claimLegacyLock(session: string): void {
    const legacyProfile = this.legacyProfilePath(session);
    const currentProfile = this.profilePath(session);
    const shouldClaim = legacyProfile === currentProfile;
    if (!existsSync(legacyProfile)) {
      if (!shouldClaim) return;
      ensurePrivateDirectorySync(legacyProfile);
    } else if (shouldClaim) {
      ensurePrivateDirectorySync(legacyProfile);
    }
    const legacyPath = join(legacyProfile, ".lock");
    for (let attempt = 0; attempt < 3; attempt++) {
      if (shouldClaim) {
        try {
          writeFileSync(legacyPath, String(process.pid), { flag: "wx", mode: 0o600 });
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      } else if (!existsSync(legacyPath)) {
        return;
      }
      const observed = this.readFile(legacyPath);
      const owner = this.parseLock(observed);
      if (owner && this.isProcessAlive(owner.pid)) {
        throw new Error(
          `Browser profile for session "${session}" is owned by live PID ${owner.pid}`,
        );
      }
      if (this.readFile(legacyPath) !== observed) continue;
      try { unlinkSync(legacyPath); } catch {}
      if (!shouldClaim) return;
    }
    throw new Error(`Could not claim legacy browser profile for session "${session}"`);
  }
  private removePrimaryLock(lockPath: string, token: string): void {
    const current = this.parseLock(this.readFile(lockPath));
    if (current?.token !== token) return;
    try { unlinkSync(lockPath); } catch {}
  }

  private hasExactArgument(command: string, argument: string): boolean {
    for (const candidate of [argument, `"${argument}"`, `'${argument}'`]) {
      let offset = 0;
      while (offset < command.length) {
        const index = command.indexOf(candidate, offset);
        if (index < 0) break;
        const before = index === 0 ? "" : command[index - 1];
        const afterIndex = index + candidate.length;
        const after = afterIndex === command.length ? "" : command[afterIndex];
        if ((!before || /\s/.test(before)) && (!after || /\s/.test(after))) return true;
        offset = index + 1;
      }
    }
    return false;
  }

  private readProcessCommand(pid: number): string {
    try {
      if (process.platform === "win32") {
        return execFileSync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CommandLine`,
        ], { encoding: "utf-8", timeout: 2_000, maxBuffer: 64 * 1024 }).trim();
      }
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
        encoding: "utf-8",
        timeout: 2_000,
        maxBuffer: 64 * 1024,
      }).trim();
    } catch {
      return "";
    }
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private readFile(filePath: string): string | null {
    try {
      return readPrivateFileSync(filePath, MAX_LOCK_FILE_BYTES, "browser session lock")
        .toString("utf8");
    } catch {
      return null;
    }
  }

  private parseLock(raw: string | null): LockRecord | null {
    if (raw === null) return null;
    try {
      const result = lockRecordSchema.safeParse(JSON.parse(raw));
      if (result.success) return result.data;
    } catch {}
    const legacyPid = this.parseLegacyPid(raw);
    return legacyPid === null ? null : { pid: legacyPid, token: "legacy" };
  }

  private parseLegacyPid(raw: string): number | null {
    const normalized = raw.trim();
    if (!/^[1-9]\d*$/.test(normalized)) return null;
    const pid = Number(normalized);
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  }
}
