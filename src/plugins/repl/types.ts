/**
 * Wire types for the REPL bridge.
 *
 * These mirror cli/src/plugins/repl/supervisor.rs serialization. Keep both
 * sides in sync — Rust uses `#[serde(rename_all = "camelCase")]`.
 */

export type SessionStatus = "starting" | "ready" | "busy" | "dead";

export interface SessionInfo {
  id: string;
  cmd: string;
  status: SessionStatus;
  exitCode: number | null;
}

export interface SessionSnapshot {
  id: string;
  status: SessionStatus;
  screen: string;
  exitCode: number | null;
  cols: number;
  rows: number;
}

export type ExpectKind = "promptMatched" | "idle" | "exited" | "timedOut";

export interface ExpectOutcome {
  kind: ExpectKind;
  exitCode?: number | null;
}

export interface SpawnArgs {
  id: string;
  cmd: string;
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
}

export interface KillArgs {
  id: string;
}
