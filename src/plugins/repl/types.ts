/**
 * Wire types for the REPL bridge.
 *
 * These mirror cli/src/plugins/repl/supervisor.rs serialization. Keep both
 * sides in sync — Rust uses `#[serde(rename_all = "camelCase")]`.
 *
 * SYNC ANCHOR: SessionSnapshot here must mirror supervisor.rs SessionSnapshot
 * (serde camelCase). New optional fields added here must have a matching
 * #[serde(skip_serializing_if = "Option::is_none")] field in Rust.
 */

export type SessionStatus = "starting" | "ready" | "busy" | "dead";

export interface SessionInfo {
  id: string;
  cmd: string;
  status: SessionStatus;
  exitCode: number | null;
}

/**
 * A single filmstrip frame — a point-in-time snapshot of the vt100 grid.
 * `ts` is Unix epoch milliseconds; `grid` is the redacted screen contents.
 *
 * SYNC ANCHOR: matches FilmstripFrame in supervisor.rs (serde camelCase,
 * ts = u64 millis, grid = String).
 */
export interface FilmstripFrame {
  /** Unix epoch milliseconds when the frame was captured. */
  ts: number;
  /** Redacted vt100-rendered grid content at capture time. */
  grid: string;
}

/**
 * Snapshot response — the core legacy shape is {id, status, screen, exitCode,
 * cols, rows}. New optional fields (raw, frames) use
 * skip_serializing_if=Option::is_none on the Rust side so old clients never
 * see them.
 */
export interface SessionSnapshot {
  id: string;
  status: SessionStatus;
  /** vt100-rendered grid (always present; redacted by both Rust + TS). */
  screen: string;
  exitCode: number | null;
  cols: number;
  rows: number;
  /**
   * Present when mode is 'raw' or 'both'. Contains the capped PTY byte
   * stream (RAW_BUFFER_CAP_BYTES=256KB). ANSI/OSC controls may remain in this
   * raw representation, but credential matches span those controls before the
   * response is returned.
   */
  raw?: string;
  /**
   * Present when history is truthy. Chronological filmstrip frames, each
   * individually redacted. Empty array when no frames captured yet (S11).
   */
  frames?: FilmstripFrame[];
}

export type SnapshotMode = "grid" | "raw" | "both";

export type ExpectKind = "promptMatched" | "idle" | "exited" | "timedOut";

export interface ExpectOutcome {
  kind: ExpectKind;
  exitCode?: number | null;
}

export interface SpawnArgs {
  id: string;
  cmd: string;
  /** Defaults to the MCP server's current directory; relative paths resolve from it. */
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  promptRegex?: string;
  /**
   * Run `cmd` through `/bin/sh -c` so shell syntax (env-var prefixes,
   * redirections, pipes, globs, `&&`) is honoured. Default false: `cmd` is
   * argv-split and exec'd directly with no shell.
   */
  shell?: boolean;
  /**
   * When true, tee PTY output to an asciicast v2 file in the plugin temp dir.
   * When a string, use it as the explicit cast file path (path-traversal is
   * rejected server-side; only paths inside the temp-dir allowlist are accepted).
   * Spawn result will include castFile when recording is active.
   */
  record?: boolean | string;
}

export interface SpawnResult {
  id: string;
  /**
   * Absolute path to the asciicast v2 file when record was requested.
   * Omitted when recording was not requested (S13).
   */
  castFile?: string;
}

export interface SendArgs {
  id: string;
  text: string;
  newline?: boolean;
}

export interface KeyArgs {
  id: string;
  key:
    | "enter"
    | "ctrl-c"
    | "ctrl-d"
    | "ctrl-z"
    | "tab"
    | "up"
    | "down"
    | "left"
    | "right";
}

export interface ExpectArgs {
  id: string;
  regex?: string;
  idleMs?: number;
  timeoutMs?: number;
}

export interface SnapshotArgs {
  id: string;
  tail?: number;
  /**
   * Which surface to return. Default 'grid' preserves the legacy shape.
   * - 'grid': vt100-rendered screen.
   * - 'raw': capped raw PTY byte stream (ANSI/OSC controls may remain;
   *          credential matches span those controls).
   * - 'both': both grid and raw fields present.
   * Invalid values are rejected at the bridge layer (S4).
   */
  mode?: SnapshotMode;
  /**
   * When truthy, include filmstrip history.
   * - true or absent number: return last ~10 frames.
   * - N (positive integer): return last N frames.
   * Returns frames:[] when none captured yet (S11).
   */
  history?: boolean | number;
}

export interface ResizeArgs {
  id: string;
  cols: number;
  rows: number;
}

export interface KillArgs {
  id: string;
}
