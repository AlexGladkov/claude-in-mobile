/**
 * JSON-RPC stdio client for the Rust REPL supervisor.
 *
 * Spawns `mcp-devices-cli repl-supervisor` once per plugin instance and
 * multiplexes requests over its stdin/stdout. Line-delimited JSON; correlation
 * by `id`. The supervisor process is killed on `dispose()` and on Node exit.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";

const MAX_RPC_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_RPC_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const MAX_TIMEOUT_MS = 5 * 60_000;
const replReadyMessageSchema = z.object({
  event: z.literal("ready"),
}).passthrough();
const replResponseMessageSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  error: z.string().max(64 * 1024).optional(),
  result: z.unknown().optional(),
}).passthrough();

export interface ReplBridgeOptions {
  /** Path to the native CLI. Defaults to MCP_DEVICES_BIN or "mcp-devices-cli". */
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
  private stdoutBuffer = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private stdoutBytes = 0;
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
      process.env.MCP_DEVICES_BIN ??
      "mcp-devices-cli";
    if (
      this.binaryPath.length === 0
      || this.binaryPath.length > 4096
      || this.binaryPath.includes("\0")
    ) {
      throw new ReplBridgeError("invalid supervisor binary path");
    }
    this.env = opts.env ?? minimalEnv();
    if (
      Object.keys(this.env).length > 256
      || Object.entries(this.env).some(
        ([key, value]) =>
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)
          || (value !== undefined && value.length > 64 * 1024),
      )
    ) {
      throw new ReplBridgeError("invalid supervisor environment");
    }
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs)
      || this.requestTimeoutMs < 1
      || this.requestTimeoutMs > MAX_TIMEOUT_MS
      || !Number.isSafeInteger(this.startTimeoutMs)
      || this.startTimeoutMs < 1
      || this.startTimeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new ReplBridgeError("invalid supervisor timeout");
    }
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
      } catch (cause) {
        settleReject(supervisorSpawnError(cause));
        return;
      }
      this.child = child;
      const exitHandler = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      };
      this.exitHandler = exitHandler;
      process.once("exit", exitHandler);
      const releaseChild = (): boolean => {
        process.removeListener("exit", exitHandler);
        if (this.child !== child) return false;
        this.child = undefined;
        this.stdoutBuffer = "";
        this.stdoutDecoder.end();
        this.stdoutBytes = 0;
        if (this.exitHandler === exitHandler) this.exitHandler = undefined;
        return true;
      };

      startTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        releaseChild();
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
      child.on("error", (cause: NodeJS.ErrnoException) => {
        if (!releaseChild()) return;
        const error = supervisorSpawnError(cause);
        this.failAllPending(error);
        settleReject(error);
      });
      child.on("exit", (code, signal) => {
        if (!releaseChild()) return;
        const reason = `supervisor exited (code=${code}, signal=${signal})`;
        this.failAllPending(new ReplBridgeError(reason));
        this.readyPromise = undefined;
        settleReject(new ReplBridgeError(reason));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (this.child !== child) return;
        this.stdoutBytes += chunk.byteLength;
        this.stdoutBuffer += this.stdoutDecoder.write(chunk);
        if (this.stdoutBytes > MAX_RPC_MESSAGE_BYTES) {
          child.kill("SIGKILL");
          this.failAllPending(new ReplBridgeError("supervisor response exceeded the size limit"));
          return;
        }
        while (true) {
          const newline = this.stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = this.stdoutBuffer.slice(0, newline);
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          this.onLine(line, settleResolve);
        }
        this.stdoutBytes = Buffer.byteLength(this.stdoutBuffer, "utf8");
      });
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
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(method)) {
      throw new ReplBridgeError("invalid supervisor method");
    }
    await this.start();
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new ReplBridgeError("supervisor not running");
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      throw new ReplBridgeError("too many pending supervisor requests");
    }
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
    if (
      !Number.isSafeInteger(effectiveTimeout)
      || effectiveTimeout < 1
      || effectiveTimeout > MAX_TIMEOUT_MS
    ) {
      throw new ReplBridgeError("invalid request timeout");
    }
    if (this.nextId >= Number.MAX_SAFE_INTEGER) this.nextId = 1;
    const id = `r${this.nextId++}`;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    if (Buffer.byteLength(payload, "utf8") > MAX_RPC_REQUEST_BYTES) {
      throw new ReplBridgeError("supervisor request exceeded the size limit");
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new ReplBridgeError(
          `request ${method} timed out after ${effectiveTimeout}ms`
        );
        child.kill("SIGKILL");
        this.child = undefined;
        this.readyPromise = undefined;
        this.failAllPending(error);
      }, effectiveTimeout);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });
      child.stdin.write(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new ReplBridgeError("failed to write to REPL supervisor"));
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
    this.readyPromise = undefined;
    this.stdoutBuffer = "";
    this.stdoutBytes = 0;
    this.stdoutDecoder.end();
    if (this.exitHandler) {
      process.removeListener("exit", this.exitHandler);
      this.exitHandler = undefined;
    }
    this.failAllPending(new ReplBridgeError("supervisor disposed"));
  }

  private onLine(line: string, onReady: () => void): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (replReadyMessageSchema.safeParse(parsed).success) {
      onReady();
      return;
    }
    const result = replResponseMessageSchema.safeParse(parsed);
    if (!result.success) return;
    const pending = this.pending.get(result.data.id);
    if (!pending) return;
    this.pending.delete(result.data.id);
    clearTimeout(pending.timer);
    if (result.data.error !== undefined) {
      pending.reject(new ReplBridgeError(
        sanitizeErrorMessage(result.data.error).slice(0, 1000),
      ));
    } else {
      pending.resolve(result.data.result);
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

function supervisorSpawnError(cause: unknown): ReplBridgeError {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? cause.code
      : undefined;
  if (code === "ENOENT") {
    return new ReplBridgeError(
      "REPL native companion not found (ENOENT); install `mcp-devices-cli` or set `MCP_DEVICES_BIN`",
    );
  }
  const suffix =
    typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)
      ? ` (${code})`
      : "";
  return new ReplBridgeError(`failed to spawn REPL supervisor${suffix}`);
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
  if (process.platform === "linux") {
    // GUI-launched MCP hosts often provide a reduced PATH. Preserve its order,
    // then make the documented /usr/local/bin install and system commands
    // available to both the native companion and its PTY children.
    const paths = new Set(out.PATH ? out.PATH.split(delimiter) : []);
    paths.add("/usr/local/bin");
    paths.add("/usr/bin");
    paths.add("/bin");
    out.PATH = [...paths].join(delimiter);
  }
  return out;
}
