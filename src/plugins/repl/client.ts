/**
 * JSON-RPC stdio client for the Rust REPL supervisor.
 *
 * Spawns `claude-in-mobile repl-supervisor` once per plugin instance and
 * multiplexes requests over its stdin/stdout. Line-delimited JSON; correlation
 * by `id`. The supervisor process is killed on `dispose()` and on Node exit.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

export interface ReplBridgeOptions {
  /** Path to the claude-in-mobile binary. Defaults to the env override or "claude-in-mobile". */
  binaryPath?: string;
  /** Sanitized environment passed to the supervisor process. */
  env?: NodeJS.ProcessEnv;
  /** Per-request timeout (ms). Default 30s — well above any expect timeout. */
  requestTimeoutMs?: number;
  /**
   * Startup timeout (ms): how long to wait for the supervisor's `ready`
   * event before giving up. Default 10s. Guards against a supervisor binary
   * that spawns but never emits `ready` (wrong/old binary, hung process).
   */
  startTimeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export class ReplBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplBridgeError";
  }
}

export class ReplBridgeClient {
  private child?: ChildProcessWithoutNullStreams;
  private rl?: Interface;
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private readyPromise?: Promise<void>;
  private exitHandler?: () => void;
  private readonly binaryPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly requestTimeoutMs: number;
  private readonly startTimeoutMs: number;

  constructor(opts: ReplBridgeOptions = {}) {
    this.binaryPath =
      opts.binaryPath ??
      process.env.CLAUDE_IN_MOBILE_BIN ??
      "claude-in-mobile";
    this.env = opts.env ?? minimalEnv();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 10_000;
  }

  async start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    const promise = new Promise<void>((resolve, reject) => {
      // start() settles exactly once. The hazard this guards against: the
      // supervisor child exits (or never speaks) before emitting `ready`, in
      // which case neither `resolve` nor `reject` lives in the `pending` map,
      // so `failAllPending` cannot unblock us — start() would hang forever and
      // the per-request timeout (armed only inside call(), after start()
      // resolves) never gets a chance to fire. See issue #46.
      let settled = false;
      let startTimer: NodeJS.Timeout | undefined;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        if (startTimer) clearTimeout(startTimer);
        resolve();
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        if (startTimer) clearTimeout(startTimer);
        reject(err);
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.binaryPath, ["repl-supervisor"], {
          env: this.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (e) {
        settleReject(
          new ReplBridgeError(
            `failed to spawn ${this.binaryPath}: ${(e as Error).message}`
          )
        );
        return;
      }
      this.child = child;

      startTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        this.child = undefined;
        settleReject(
          new ReplBridgeError(
            `supervisor did not emit ready within ${this.startTimeoutMs}ms — ` +
              `check that ${this.binaryPath} is a current build with the ` +
              `repl-supervisor subcommand`
          )
        );
      }, this.startTimeoutMs);
      // Don't keep the event loop alive solely for the startup timer.
      startTimer.unref?.();

      child.stderr.on("data", (chunk: Buffer) => {
        // Surface supervisor stderr at warn level via dedicated callback later;
        // for now silently drop to avoid mixing into MCP stdout framing.
        void chunk;
      });
      child.on("error", (err) => {
        this.failAllPending(err);
        settleReject(
          new ReplBridgeError(`supervisor process error: ${err.message}`)
        );
      });
      child.on("exit", (code, signal) => {
        const reason = `supervisor exited (code=${code}, signal=${signal})`;
        this.failAllPending(new ReplBridgeError(reason));
        this.child = undefined;
        // Unblock a start() that was still waiting for `ready`.
        settleReject(new ReplBridgeError(reason));
      });
      this.rl = createInterface({ input: child.stdout });
      this.rl.on("line", (line) => this.onLine(line, settleResolve));
      this.exitHandler = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      };
      process.once("exit", this.exitHandler);
    });
    // On failed startup, drop the cached promise so a later call() retries a
    // fresh supervisor instead of re-throwing the same dead-on-arrival error.
    promise.catch(() => {
      if (this.readyPromise === promise) this.readyPromise = undefined;
    });
    this.readyPromise = promise;
    return promise;
  }

  /**
   * @param timeoutMs Per-call timeout override. Callers whose request can
   *   legitimately block longer than the default (e.g. `expect` with a large
   *   `timeoutMs`) must pass a value here, otherwise the request would be
   *   rejected client-side while the supervisor is still working — leaving the
   *   session wedged and the late response dropped.
   */
  async call<T = unknown>(
    method: string,
    params: unknown = {},
    timeoutMs?: number
  ): Promise<T> {
    await this.start();
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new ReplBridgeError("supervisor not running");
    }
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
    const id = `r${this.nextId++}`;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ReplBridgeError(
            `request ${method} timed out after ${effectiveTimeout}ms`
          )
        );
      }, effectiveTimeout);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      child.stdin.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new ReplBridgeError(`write failed: ${err.message}`));
        }
      });
    });
  }

  async dispose(): Promise<void> {
    if (!this.child) return;
    try {
      await this.call("shutdown");
    } catch {
      /* supervisor may already be gone */
    }
    this.child?.kill("SIGTERM");
    this.child = undefined;
    if (this.exitHandler) {
      process.removeListener("exit", this.exitHandler);
      this.exitHandler = undefined;
    }
    this.failAllPending(new ReplBridgeError("supervisor disposed"));
  }

  private onLine(line: string, onReady: () => void): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event === "ready") {
      onReady();
      return;
    }
    const id = typeof msg.id === "string" ? msg.id : null;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (typeof msg.error === "string") {
      pending.reject(new ReplBridgeError(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

function minimalEnv(): NodeJS.ProcessEnv {
  // Allowlist only what a PTY supervisor needs. Additional vars per session
  // are passed through `spawn.params.env`, not through the supervisor's own
  // process environment. See Phase 11 security baseline.
  const allow = ["PATH", "HOME", "LANG", "LC_ALL", "TZ"];
  const out: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}
