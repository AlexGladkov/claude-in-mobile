/**
 * REPL plugin — first non-platform first-party plugin.
 *
 * Owns a long-lived `ReplBridgeClient` that fronts the Rust supervisor
 * (cli/src/plugins/repl/bridge.rs). Tools are registered via PluginContext
 * during `init`; dispose tears down the supervisor process.
 *
 * v4.1.0 adds: mode/history on snapshot, filmstrip ring buffer, asciicast v2
 * tee, and repl_resize. apiVersion remains '1' — all additions are additive
 * with optional parameters (R10, R11, BLOCKER B).
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
  ToolDefinition,
} from "@mcp-devices/plugin-api";

import { ReplBridgeClient } from "./client.js";
import type {
  ExpectArgs,
  ExpectOutcome,
  KeyArgs,
  KillArgs,
  ResizeArgs,
  SendArgs,
  SessionInfo,
  SessionSnapshot,
  SnapshotArgs,
  SpawnArgs,
  SpawnResult,
} from "./types.js";
import { REDACTION_PATTERNS, redactScreen } from "./redaction.js";

export const REPL_PLUGIN_MANIFEST: PluginManifest = {
  id: "repl",
  name: "REPL",
  version: "4.4.0",
  // apiVersion MUST stay '1' — kernel-wide constant PLUGIN_API_VERSION='1';
  // bumping causes ApiVersionMismatchError at registration (BLOCKER B).
  apiVersion: "1",
  capabilities: ["terminal", "input"],
  // SYNC ANCHOR: this tools array must match contract.test.ts assertion (8 tools).
  tools: [
    "repl_spawn",
    "repl_send",
    "repl_key",
    "repl_expect",
    "repl_snapshot",
    "repl_list",
    "repl_kill",
    "repl_resize",
  ],
  description:
    "Interactive REPL automation (python/node/bash/...) via PTY + vt100 emulator",
};

export interface ReplPluginOptions {
  /** Inject a bridge for testing. */
  bridge?: ReplBridgeClient;
  /** Disable secret redaction (default: enabled). */
  disableRedaction?: boolean;
}

export class ReplPlugin implements SourcePlugin {
  readonly manifest = REPL_PLUGIN_MANIFEST;
  private bridge: ReplBridgeClient;
  private readonly redact: boolean;

  constructor(opts: ReplPluginOptions = {}) {
    this.bridge = opts.bridge ?? new ReplBridgeClient();
    this.redact = !opts.disableRedaction;
  }

  init(ctx: PluginContext): void {
    for (const def of this.toolDefinitions()) {
      ctx.registerTool(def);
    }
  }

  async dispose(): Promise<void> {
    await this.bridge.dispose();
  }

  // -- Tool surface ---------------------------------------------------------

  async spawn(args: SpawnArgs): Promise<SpawnResult> {
    return this.bridge.call("spawn", args);
  }

  async send(args: SendArgs): Promise<{ ok: true }> {
    return this.bridge.call("send", args);
  }

  async key(args: KeyArgs): Promise<{ ok: true }> {
    return this.bridge.call("key", args);
  }

  /** Buffer added to a session's expect timeout for the bridge round-trip. */
  private static readonly EXPECT_TIMEOUT_BUFFER_MS = 5_000;

  async expect(args: ExpectArgs): Promise<ExpectOutcome> {
    // The bridge request must outlive the server-side expect wait, otherwise
    // the client rejects while the supervisor is still polling. Default expect
    // timeout server-side is 5000ms (see bridge.rs / ExpectRules::defaults).
    const serverTimeout = args.timeoutMs ?? 5_000;
    return this.bridge.call(
      "expect",
      args,
      serverTimeout + ReplPlugin.EXPECT_TIMEOUT_BUFFER_MS
    );
  }

  async snapshot(args: SnapshotArgs): Promise<SessionSnapshot> {
    const snap = await this.bridge.call<SessionSnapshot>("snapshot", args);
    if (!this.redact) return snap;
    return applyRedactionToSnapshot(snap);
  }

  async list(): Promise<SessionInfo[]> {
    const sessions = await this.bridge.call<SessionInfo[]>("list");
    // `cmd` can carry inline secrets (e.g. `TOKEN=x cmd`, `mysql -psecret`),
    // so it must be redacted on this egress too — not just in snapshot().
    return this.redact
      ? sessions.map((s) => ({ ...s, cmd: redactScreen(s.cmd) }))
      : sessions;
  }

  async kill(args: KillArgs): Promise<{ ok: true }> {
    return this.bridge.call("kill", args);
  }

  async resize(args: ResizeArgs): Promise<{ ok: true }> {
    return this.bridge.call("resize", args);
  }

  // -- MCP tool definitions -------------------------------------------------

  private toolDefinitions(): ToolDefinition[] {
    return [
      {
        name: "repl_spawn",
        description:
          "Start an interactive REPL or CLI process under a PTY. Returns the session id. " +
          "cmd is exec'd directly (argv split, no shell): env-var prefixes, " +
          "redirections (2>&1), pipes and globs are NOT interpreted — pass env via " +
          "the env param, or set shell:true to run cmd through /bin/sh -c. " +
          "Set record:true to tee redacted PTY output to an asciicast v2 file " +
          "(returned as castFile); supply castPath to override the default temp location.",
        inputSchema: {
          type: "object",
          required: ["id", "cmd"],
          properties: {
            id: { type: "string", description: "Session name (unique)" },
            cmd: { type: "string", description: "Command line to spawn" },
            cwd: { type: "string" },
            env: { type: "object", additionalProperties: { type: "string" } },
            cols: {
              type: "integer",
              default: 120,
              description: "PTY width (clamped 1..=1000, default 120)",
            },
            rows: {
              type: "integer",
              default: 40,
              description: "PTY height (clamped 1..=1000, default 40)",
            },
            promptRegex: { type: "string" },
            shell: {
              type: "boolean",
              default: false,
              description:
                "Run cmd via /bin/sh -c so shell syntax (env prefixes, 2>&1, pipes, globs, &&) works.",
            },
            record: {
              oneOf: [{ type: "boolean" }, { type: "string" }],
              default: false,
              description:
                "Enable asciicast v2 tee. true=auto path in temp dir; string=explicit castPath " +
                "(must be inside the plugin temp-dir allowlist, path-traversal rejected).",
            },
          },
        },
        handler: (args) => this.spawn(args as SpawnArgs),
      },
      {
        name: "repl_send",
        description:
          "Write text to a REPL session. Appends a newline by default.",
        inputSchema: {
          type: "object",
          required: ["id", "text"],
          properties: {
            id: { type: "string" },
            text: { type: "string" },
            newline: { type: "boolean", default: true },
          },
        },
        handler: (args) => this.send(args as SendArgs),
      },
      {
        name: "repl_key",
        description:
          "Send a named key to a session. Editing/navigation for driving TUIs. " +
          "Supported: enter, tab, shift-tab, space, backspace, esc (alias escape), " +
          "delete, home, end, pageup, pagedown, up, down, left, right, " +
          "ctrl-a, ctrl-c, ctrl-d, ctrl-e, ctrl-k, ctrl-l, ctrl-n, ctrl-o, ctrl-p, " +
          "ctrl-r, ctrl-u, ctrl-w, ctrl-z. For plain characters use repl_send.",
        inputSchema: {
          type: "object",
          required: ["id", "key"],
          properties: {
            id: { type: "string" },
            key: {
              type: "string",
              enum: [
                "enter", "tab", "shift-tab", "space", "backspace", "esc", "escape",
                "delete", "home", "end", "pageup", "pagedown",
                "up", "down", "left", "right",
                "ctrl-a", "ctrl-c", "ctrl-d", "ctrl-e", "ctrl-k", "ctrl-l",
                "ctrl-n", "ctrl-o", "ctrl-p", "ctrl-r", "ctrl-u", "ctrl-w", "ctrl-z",
              ],
            },
          },
        },
        handler: (args) => this.key(args as KeyArgs),
      },
      {
        name: "repl_expect",
        description:
          "Block until a prompt regex matches, the session idles, the child exits, or the timeout fires.",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            regex: { type: "string" },
            idleMs: { type: "integer", default: 300 },
            timeoutMs: { type: "integer", default: 5000 },
          },
        },
        handler: (args) => this.expect(args as ExpectArgs),
      },
      {
        name: "repl_snapshot",
        description:
          "Read the current emulated terminal screen for a session. " +
          "All returned text surfaces are redacted for common secret patterns. " +
          "mode: 'grid' (default) returns only the vt100-rendered screen — " +
          "strongest redaction guarantee since ANSI escapes are resolved before " +
          "regex matching. 'raw' returns the capped PTY byte stream (ANSI escapes " +
          "present; secrets split across escape sequences may survive redaction — " +
          "use 'grid' when in doubt). 'both' returns grid and raw. " +
          "history:true|N returns the last N filmstrip frames (default 10) " +
          "as frames:[{ts,grid}]; empty array when none captured yet.",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            tail: { type: "integer", description: "Trailing lines to return" },
            mode: {
              type: "string",
              enum: ["grid", "raw", "both"],
              default: "grid",
              description:
                "Which surface to return: grid=vt100 screen (default), raw=byte stream, both=both. " +
                "Invalid values are rejected.",
            },
            history: {
              oneOf: [
                { type: "boolean" },
                { type: "integer", minimum: 1, maximum: 50 },
              ],
              default: false,
              description:
                "Return filmstrip history. true=last 10 frames; N=last N frames (clamped 1..=50=FILMSTRIP_CAP). " +
                "Returns frames:[] when no frames captured yet.",
            },
          },
        },
        handler: (args) => this.snapshot(args as SnapshotArgs),
      },
      {
        name: "repl_list",
        description: "List active REPL sessions and their statuses.",
        inputSchema: { type: "object", properties: {} },
        handler: () => this.list(),
      },
      {
        name: "repl_kill",
        description: "Terminate a REPL session (SIGTERM, then SIGKILL).",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        handler: (args) => this.kill(args as KillArgs),
      },
      {
        name: "repl_resize",
        description:
          "Resize the PTY and vt100 grid for a live session. " +
          "Applies cols/rows to BOTH the PTY master (MasterPty::resize) and the " +
          "vt100 parser (set_size) in that order so the grid stays consistent. " +
          "Subsequent repl_snapshot will report the new cols/rows. " +
          "Values are clamped to 1..=1000.",
        inputSchema: {
          type: "object",
          required: ["id", "cols", "rows"],
          properties: {
            id: { type: "string", description: "Session id" },
            cols: {
              type: "integer",
              description: "New PTY width (1..=1000)",
            },
            rows: {
              type: "integer",
              description: "New PTY height (1..=1000)",
            },
          },
        },
        handler: (args) => this.resize(args as ResizeArgs),
      },
    ];
  }
}

// -- Defense-in-depth TS-side redaction (R2, S5, S6, S10) -------------------

/**
 * Apply redactScreen to all textual surfaces on a SessionSnapshot.
 *
 * This is defense-in-depth on top of the Rust-side redaction that runs in the
 * reader thread. The Rust layer is the primary gate for raw/cast/filmstrip
 * paths; the TS layer catches anything that slips through the wire and guards
 * the screen field that Rust already redacts (double-layer for screen).
 *
 * Surfaces covered:
 *  - snap.screen (always present)
 *  - snap.raw (present when mode:'raw'|'both')
 *  - snap.frames[*].grid (present when history truthy)
 */
function applyRedactionToSnapshot(snap: SessionSnapshot): SessionSnapshot {
  const result: SessionSnapshot = {
    ...snap,
    screen: redactScreen(snap.screen),
  };
  if (snap.raw !== undefined) {
    result.raw = redactScreen(snap.raw);
  }
  if (snap.frames !== undefined) {
    result.frames = snap.frames.map((f) => ({
      ...f,
      grid: redactScreen(f.grid),
    }));
  }
  return result;
}

export function createReplPlugin(opts: ReplPluginOptions = {}): SourcePlugin {
  return new ReplPlugin(opts);
}

export { REDACTION_PATTERNS };
