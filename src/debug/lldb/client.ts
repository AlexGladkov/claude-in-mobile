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
        continue; // ignore non-JSON noise
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

  /** Send a JSON-RPC request and await the result. */
  rpc(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.proc) return Promise.reject(new Error("LLDB daemon not started"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(JSON.stringify({ id, method, params }) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.rpc("shutdown", {});
    } catch {
      /* forcing down anyway */
    }
    this.proc?.kill();
    this.proc = undefined;
  }
}
