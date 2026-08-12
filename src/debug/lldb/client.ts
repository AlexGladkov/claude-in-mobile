/**
 * LldbClient — TS driver for the iOS LLDB Python sidecar
 * (scripts/ios-debug-daemon.py). Spawns one long-lived daemon under Xcode's
 * python (ABI-matched to the LLDB framework), speaks newline-delimited JSON-RPC
 * over stdio, and exposes the debug verbs. One daemon can hold several sessions.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pexec = promisify(execFile);

interface RpcPending {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
}

export class LldbClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, RpcPending>();
  private stdoutBuf = "";
  private starting?: Promise<void>;
  private exitHook?: () => void;

  /** Resolve the daemon script path (works from dist/ at runtime). */
  private daemonPath(): string {
    // dist/debug/lldb/client.js → repo/scripts/ios-debug-daemon.py
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../../../scripts/ios-debug-daemon.py");
  }

  /** Start the daemon (idempotent). Requires macOS + Xcode LLDB python bindings. */
  async start(): Promise<void> {
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    try {
      await this.starting;
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
    const { stdout } = await pexec("xcrun", ["lldb", "-P"]);
    const pythonPath = stdout.trim();

    const proc = spawn("xcrun", ["python3", this.daemonPath()], {
      env: { ...process.env, PYTHONPATH: pythonPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    proc.on("exit", () => this.failAll(new Error("LLDB daemon exited")));
    proc.on("error", (e) => this.failAll(e));

    // Never orphan the python daemon (and its debugserver / suspended app) if
    // the Node process goes away.
    if (!this.exitHook) {
      this.exitHook = () => this.proc?.kill("SIGKILL");
      process.once("exit", this.exitHook);
    }

    // Sanity ping so start() rejects fast if lldb bindings are missing.
    const pong = await this.rpc("ping", {});
    if (!pong?.lldb) throw new Error("LLDB daemon did not report working lldb bindings");
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON noise (LLDB chatter should go to stderr)
      }
      // A fatal daemon error (e.g. lldb bindings unavailable) has no id — it is
      // a broadcast; surface it to every waiter instead of dropping it.
      if (msg.id == null) {
        if (msg.ok === false && msg.error) this.failAll(new Error(msg.error));
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "LLDB daemon error"));
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.proc = undefined;
  }

  /** Send a JSON-RPC request and await the result (rejects on timeout so a
   *  wedged daemon can never hang the caller forever). */
  rpc(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    if (!this.proc) return Promise.reject(new Error("LLDB daemon not started"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`LLDB daemon RPC '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      const settle = {
        resolve: (r: any) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.pending.set(id, settle);
      this.proc!.stdin!.write(JSON.stringify({ id, method, params }) + "\n", (err) => {
        if (err && this.pending.delete(id)) {
          clearTimeout(timer);
          reject(err);
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
      /* forcing down anyway */
    }
    proc.kill();
    // Reap a daemon wedged in a native LLDB call if it ignores SIGTERM.
    setTimeout(() => proc.kill("SIGKILL"), 2000).unref?.();
    this.proc = undefined;
  }
}
