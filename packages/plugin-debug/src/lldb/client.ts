/**
 * LldbClient — TS driver for the iOS LLDB Python sidecar
 * (bin/ios-debug-daemon.py). Spawns one long-lived daemon under Xcode's
 * python (ABI-matched to the LLDB framework), speaks newline-delimited JSON-RPC
 * over stdio, and exposes the debug verbs. One daemon can hold several sessions.
 *
 * Security: the daemon is spawned ONLY from the fixed in-package path —
 * never from args/env override (invariant 5).
 */

import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";


const pexec = promisify(execFile);
const RPC_TIMEOUT_MS = 30_000;
const MAX_RPC_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_RPC_REQUEST_BYTES = 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const STOP_TIMEOUT_MS = 2_000;
const lldbResponseSchema = z.object({
  id: z.number().int().safe().optional(),
  ok: z.boolean(),
  result: z.unknown().optional(),
}).passthrough();
const lldbPingResultSchema = z.object({
  lldb: z.boolean(),
}).passthrough();



interface RpcPending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class LldbClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, RpcPending>();
  private stdoutBuf = "";
  private stdoutBytes = 0;
  private starting?: Promise<void>;
  private exitHook?: () => void;

  /**
   * Resolve the daemon script path from the package install location.
   * dist/lldb/client.js → ../bin/ios-debug-daemon.py (stable after npm install).
   * SECURITY: this path is hardcoded — no DAEMON_PATH/PYTHON env override.
   */
  private daemonPath(): string {
    // dist/lldb/client.js (2 levels deep) → dist/ → ../bin/
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, "..", "..", "bin", "ios-debug-daemon.py");
  }

  /** Start the daemon (idempotent). Requires macOS + Xcode LLDB python bindings. */
  async start(): Promise<void> {
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    try {
      await this.starting;
    } catch (error: unknown) {
      await this.stop();
      throw error;
    } finally {
      this.starting = undefined;
    }
  }

  private async doStart(): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error(
        `iOS debug requires macOS + Xcode — not supported on ${process.platform}. (Android debug works everywhere.)`,
      );
    }
    // Xcode's python must import lldb; PYTHONPATH comes from `xcrun lldb -P`.
    const { stdout } = await pexec("xcrun", ["lldb", "-P"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    const pythonPath = stdout.trim();

    // SECURITY: spawn only the fixed package-relative path — no env override.
    const daemonScript = this.daemonPath();
    const proc = spawn("xcrun", ["python3", daemonScript], {
      env: { ...process.env, PYTHONPATH: pythonPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    // Drain LLDB chatter continuously; an unread pipe can block the daemon.
    proc.stderr!.resume();
    proc.on("exit", () => {
      if (this.proc === proc) this.failAll(new Error("LLDB daemon exited"));
    });
    proc.on("error", () => {
      if (this.proc === proc) this.failAll(new Error("LLDB daemon failed"));
    });

    // Never orphan the python daemon (and its debugserver / suspended app) if
    // the Node process goes away.
    if (!this.exitHook) {
      this.exitHook = () => this.proc?.kill("SIGKILL");
      process.once("exit", this.exitHook);
    }

    // Sanity ping so start() rejects fast if lldb bindings are missing.
    const pong = lldbPingResultSchema.parse(await this.rpc("ping", {}));
    if (!pong.lldb) throw new Error("LLDB daemon did not report working lldb bindings");
  }

  private onStdout(chunk: string): void {
    this.stdoutBytes += Buffer.byteLength(chunk, "utf8");
    if (this.stdoutBytes > MAX_RPC_MESSAGE_BYTES) {
      const proc = this.proc;
      this.failAll(new Error("LLDB daemon response exceeded the size limit"));
      if (proc) void this.terminate(proc);
      return;
    }
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBytes -= Buffer.byteLength(this.stdoutBuf.slice(0, nl + 1), "utf8");
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const result = lldbResponseSchema.safeParse(parsed);
      if (!result.success) continue;
      const response = result.data;
      if (response.id === undefined) {
        if (!response.ok) this.failAll(new Error("LLDB daemon reported a fatal error"));
        continue;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error("LLDB daemon request failed"));
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.stdoutBuf = "";
    this.stdoutBytes = 0;
    this.proc = undefined;
  }

  /**
   * Send a JSON-RPC request and await the result (rejects on timeout so a
   * wedged daemon can never hang the caller forever).
   */
  rpc(method: string, params: Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    const proc = this.proc;
    const stdin = proc?.stdin;
    if (!proc || !stdin) return Promise.reject(new Error("LLDB daemon not started"));
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(method)) {
      return Promise.reject(new Error("Invalid LLDB RPC method"));
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
      return Promise.reject(new Error("Invalid LLDB RPC timeout"));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("Too many pending LLDB RPC requests"));
    }
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, method, params })}\n`;
    if (Buffer.byteLength(payload) > MAX_RPC_REQUEST_BYTES) {
      return Promise.reject(new Error("LLDB daemon request exceeded the size limit"));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.failAll(new Error("LLDB daemon RPC timed out"));
        void this.terminate(proc);
      }, timeoutMs);
      const settle: RpcPending = {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.pending.set(id, settle);
      stdin.write(payload, (error) => {
        if (error && this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new Error("Failed to write LLDB daemon request"));
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.exitHook) {
      process.removeListener("exit", this.exitHook);
      this.exitHook = undefined;
    }
    const proc = this.proc;
    if (!proc) return;
    try {
      await this.rpc("shutdown", {}, 3000);
    } catch {
      // The process is terminated below even when graceful shutdown fails.
    }
    await this.terminate(proc);
    if (this.proc === proc) this.failAll(new Error("LLDB daemon stopped"));
  }

  private async terminate(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const waitForExit = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
    try { proc.kill("SIGTERM"); } catch { return; }
    await Promise.race([
      waitForExit,
      new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try { proc.kill("SIGKILL"); } catch { return; }
    await Promise.race([
      waitForExit,
      new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);
  }
}
