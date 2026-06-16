import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import type { BrowserSession } from "./types.js";
import { DEFAULT_SESSION } from "./types.js";

export class SessionManager {
  private sessions = new Map<string, BrowserSession>();
  readonly profileBaseDir: string;

  constructor() {
    this.profileBaseDir = join(homedir(), ".claude-in-mobile", "browser-profiles");
  }

  sanitizeSessionName(name: string): string {
    // Remove path traversal, allow only safe chars
    let sanitized = name.replace(/[^a-zA-Z0-9_\-.]/g, "_");
    sanitized = sanitized.replace(/\.\./g, "__");
    if (sanitized.length === 0) return "default";
    if (sanitized.length > 64) sanitized = sanitized.slice(0, 64);
    return sanitized;
  }

  getProfileDir(session: string): string {
    const safeName = this.sanitizeSessionName(session);
    const profileDir = join(this.profileBaseDir, safeName);
    if (!existsSync(profileDir)) {
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    }
    return profileDir;
  }

  getSession(name?: string): BrowserSession | undefined {
    return this.sessions.get(name ?? DEFAULT_SESSION);
  }

  hasSession(name?: string): boolean {
    return this.sessions.has(name ?? DEFAULT_SESSION);
  }

  setSession(name: string, session: BrowserSession): void {
    this.sessions.set(name, session);
  }

  removeSession(name: string): void {
    this.sessions.delete(name);
  }

  listSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  writePidFile(session: string, pid: number): void {
    const profileDir = this.getProfileDir(session);
    try {
      writeFileSync(join(profileDir, ".chrome-pid"), String(pid), { mode: 0o600 });
    } catch {}
  }

  readPidFile(session: string): number | null {
    const profileDir = this.getProfileDir(session);
    const pidFile = join(profileDir, ".chrome-pid");
    if (!existsSync(pidFile)) return null;
    try {
      return parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    } catch {
      return null;
    }
  }

  removePidFile(session: string): void {
    try {
      unlinkSync(join(this.getProfileDir(session), ".chrome-pid"));
    } catch {}
  }

  writeLockFile(session: string): void {
    const profileDir = this.getProfileDir(session);
    try {
      writeFileSync(join(profileDir, ".lock"), String(process.pid), { mode: 0o600 });
    } catch {}
  }

  removeLockFile(session: string): void {
    try {
      unlinkSync(join(this.getProfileDir(session), ".lock"));
    } catch {}
  }

  isLocked(session: string): boolean {
    const lockFile = join(this.getProfileDir(session), ".lock");
    if (!existsSync(lockFile)) return false;
    try {
      const pid = parseInt(readFileSync(lockFile, "utf-8").trim(), 10);
      process.kill(pid, 0); // check if alive
      return true;
    } catch {
      // stale lock or dead process
      return false;
    }
  }

  cleanupOrphanChrome(session: string): void {
    const pid = this.readPidFile(session);
    if (pid === null) return;
    try {
      process.kill(pid, 0); // alive?
      process.kill(pid, "SIGTERM");
      console.error(`[browser] Killed orphaned Chrome PID ${pid} for session "${session}"`);
    } catch {}
    this.removePidFile(session);
  }
}
