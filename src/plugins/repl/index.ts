/**
 * REPL plugin — first non-platform first-party plugin.
 *
 * Owns a long-lived `ReplBridgeClient` that fronts the Rust supervisor
 * (cli/src/plugins/repl/bridge.rs). Tools are registered via PluginContext
 * during `init`; dispose tears down the supervisor process.
 */

import type {
  PluginContext,
  PluginManifest,
  SourcePlugin,
  ToolDefinition,
} from "@claude-in-mobile/plugin-api";

import { ReplBridgeClient } from "./client.js";
import type {
  ExpectArgs,
  ExpectOutcome,
  KeyArgs,
  KillArgs,
  SendArgs,
  SessionInfo,
  SessionSnapshot,
  SnapshotArgs,
  SpawnArgs,
} from "./types.js";
import { REDACTION_PATTERNS, redactScreen } from "./redaction.js";

export const REPL_PLUGIN_MANIFEST: PluginManifest = {
  id: "repl",
  name: "REPL",
  version: "3.11.0",
  apiVersion: "1",
  capabilities: ["terminal", "input"],
  tools: [
    "repl_spawn",
    "repl_send",
    "repl_key",
    "repl_expect",
    "repl_snapshot",
    "repl_list",
    "repl_kill",
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

  async spawn(args: SpawnArgs): Promise<{ id: string }> {
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
    return this.redact ? { ...snap, screen: redactScreen(snap.screen) } : snap;
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

  // -- MCP tool definitions -------------------------------------------------

  private toolDefinitions(): ToolDefinition[] {
    return [
      {
        name: "repl_spawn",
        description:
          "Start an interactive REPL or CLI process under a PTY. Returns the session id. " +
          "cmd is exec'd directly (argv split, no shell): env-var prefixes, " +
          "redirections (2>&1), pipes and globs are NOT interpreted — pass env via " +
          "the env param, or set shell:true to run cmd through /bin/sh -c.",
        inputSchema: {
          type: "object",
          required: ["id", "cmd"],
          properties: {
            id: { type: "string", description: "Session name (unique)" },
            cmd: { type: "string", description: "Command line to spawn" },
            cwd: { type: "string" },
            env: { type: "object", additionalProperties: { type: "string" } },
            cols: { type: "integer", default: 120 },
            rows: { type: "integer", default: 40 },
            promptRegex: { type: "string" },
            shell: {
              type: "boolean",
              default: false,
              description:
                "Run cmd via /bin/sh -c so shell syntax (env prefixes, 2>&1, pipes, globs, &&) works.",
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
          "Send a control key (enter/ctrl-c/ctrl-d/tab/arrows) to a session.",
        inputSchema: {
          type: "object",
          required: ["id", "key"],
          properties: {
            id: { type: "string" },
            key: { type: "string" },
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
          "Read the current emulated terminal screen for a session. Output is redacted for common secret patterns unless disabled at plugin construction time.",
        inputSchema: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            tail: { type: "integer", description: "Trailing lines to return" },
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
    ];
  }
}

export function createReplPlugin(opts: ReplPluginOptions = {}): SourcePlugin {
  return new ReplPlugin(opts);
}

export { REDACTION_PATTERNS };
