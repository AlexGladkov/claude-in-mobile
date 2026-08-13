/**
 * session-store -- at-rest persistence for GramJS StringSessions.
 *
 * SECURITY (T1, gate on merge). A StringSession is full, unbounded,
 * 2FA-bypassing access to the bound account. This store therefore deviates
 * DELIBERATELY from `src/utils/baseline-store.ts`:
 *
 *   - baseline-store defaults its directory to `process.cwd()/.visual-baselines`
 *     and honours a `*_DIR` env override. For a StringSession that is FATAL --
 *     the secret would land inside the project tree and get committed.
 *
 *   - This store is HOME-ONLY: the base dir is always
 *     `~/.mcp-devices/telegram`. There is NO cwd default and NO env override
 *     that could redirect it into the project tree.
 *
 * We keep the parts of the baseline-store hardening that are correct: dir mode
 * 0o700, file mode 0o600, and `validatePathContainment` against the base dir.
 */

import { mkdir, readFile, writeFile, unlink, chmod, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { validatePathContainment } from "mcp-devices/utils/sanitize";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SESSION_FILE = "session";

/**
 * Session names become directory components, so they must be tightly
 * constrained. Mode markers (`test-dc-*` / `prod-*`) fit this charset.
 */
const SESSION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,63}$/;

export class TelegramSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramSessionError";
  }
}

export function validateSessionName(name: string): void {
  if (!SESSION_NAME_RE.test(name)) {
    throw new TelegramSessionError(
      `Invalid Telegram session name: "${name}". ` +
        `Use 1-64 chars of [a-zA-Z0-9._-], starting alphanumeric.`,
    );
  }
}

export class SessionStore {
  private readonly baseDir: string;

  /**
   * @param baseDir test seam only. Production callers MUST NOT pass this -- the
   *   default (`~/.mcp-devices/telegram`) is the security boundary. Tests pass
   *   a tmp dir to avoid touching the real home directory.
   */
  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), ".mcp-devices", "telegram");
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  private sessionDir(name: string): string {
    validateSessionName(name);
    const dir = join(this.baseDir, name);
    validatePathContainment(dir, this.baseDir);
    return dir;
  }

  private sessionPath(name: string): string {
    const file = join(this.sessionDir(name), SESSION_FILE);
    validatePathContainment(file, this.baseDir);
    return file;
  }

  /** Persist a StringSession with 0o700 dir / 0o600 file. */
  async save(name: string, stringSession: string): Promise<void> {
    const dir = this.sessionDir(name);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    // mkdir's `mode` is subject to umask; re-assert it explicitly.
    await chmod(dir, DIR_MODE);
    const file = this.sessionPath(name);
    await writeFile(file, stringSession, { mode: FILE_MODE });
    await chmod(file, FILE_MODE);
  }

  /** Load a StringSession, or null if none is stored. */
  async load(name: string): Promise<string | null> {
    const file = this.sessionPath(name);
    try {
      const data = await readFile(file, "utf-8");
      return data.trim() === "" ? null : data;
    } catch {
      return null;
    }
  }

  async exists(name: string): Promise<boolean> {
    const file = this.sessionPath(name);
    try {
      await stat(file);
      return true;
    } catch {
      return false;
    }
  }

  async delete(name: string): Promise<void> {
    const file = this.sessionPath(name);
    try {
      await unlink(file);
    } catch {
      // already gone -- fine
    }
  }
}
