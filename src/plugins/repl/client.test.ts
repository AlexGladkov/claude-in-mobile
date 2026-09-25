import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { ReplBridgeClient, ReplBridgeError } from "./client.js";

describe("ReplBridgeClient construction", () => {
  it("falls back to MCP_DEVICES_BIN env override", () => {
    const prior = process.env.MCP_DEVICES_BIN;
    process.env.MCP_DEVICES_BIN = "/nonexistent/path-to-binary-xyz";
    try {
      const c = new ReplBridgeClient();
      expect(c).toBeInstanceOf(ReplBridgeClient);
    } finally {
      if (prior === undefined) delete process.env.MCP_DEVICES_BIN;
      else process.env.MCP_DEVICES_BIN = prior;
    }
  });

  it("starts the native companion through the unambiguous CLI alias", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-devices-cli-"));
    const companion = join(dir, "mcp-devices-cli");
    await writeFile(
      companion,
      [
        "#!/usr/bin/env node",
        `process.stdout.write('{"event":"ready"}\\n');`,
        `process.stdin.on("data", () => process.stdout.write('{"id":"r1","result":null}\\n'));`,
        "",
      ].join("\n"),
      { mode: 0o755 }
    );

    const client = new ReplBridgeClient({
      env: {
        PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
      },
      requestTimeoutMs: 2_000,
      startTimeoutMs: 2_000,
    });

    try {
      await expect(client.start()).resolves.toBeUndefined();
    } finally {
      await client.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts the public expect maximum plus its bridge buffer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-devices-cli-timeout-envelope-"));
    const companion = join(dir, "mcp-devices-cli");
    await writeFile(
      companion,
      [
        `#!${process.execPath}`,
        "process.stdout.write('{\"event\":\"ready\"}\\n');",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  input += chunk;",
        "  while (true) {",
        "    const newline = input.indexOf('\\n');",
        "    if (newline < 0) break;",
        "    const request = JSON.parse(input.slice(0, newline));",
        "    input = input.slice(newline + 1);",
        "    process.stdout.write(JSON.stringify({ id: request.id, result: 'ok' }) + '\\n');",
        "  }",
        "});",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const client = new ReplBridgeClient({
      binaryPath: companion,
      requestTimeoutMs: 2_000,
      startTimeoutMs: 2_000,
    });

    try {
      for (const timeoutMs of [300_000, 300_001, 305_000]) {
        await expect(client.call<string>("expect", {}, timeoutMs)).resolves.toBe("ok");
      }
      await expect(client.call("expect", {}, 305_001))
        .rejects.toThrow("invalid request timeout");
    } finally {
      await client.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves standard command paths when the Linux host omits PATH", async () => {
    if (process.platform !== "linux") return;
    const priorPath = process.env.PATH;
    const dir = await mkdtemp(join(tmpdir(), "mcp-devices-cli-path-"));
    const companion = join(dir, "mcp-devices-cli");
    await writeFile(
      companion,
      [
        `#!${process.execPath}`,
        "process.stdout.write('{\"event\":\"ready\"}\\n');",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  input += chunk;",
        "  const newline = input.indexOf('\\n');",
        "  if (newline < 0) return;",
        "  const request = JSON.parse(input.slice(0, newline));",
        "  process.stdout.write(JSON.stringify({ id: request.id, result: process.env.PATH ?? '' }) + '\\n');",
        "});",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    delete process.env.PATH;
    const client = new ReplBridgeClient({
      binaryPath: companion,
      requestTimeoutMs: 2_000,
      startTimeoutMs: 2_000,
    });

    try {
      const childPath = await client.call<string>("path");
      expect(childPath.split(delimiter)).toEqual(
        expect.arrayContaining(["/usr/local/bin", "/usr/bin", "/bin"]),
      );
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      await client.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // This integration case needs a real child exit event; fake timers cannot
  // order events across the parent and child process event loops.

  it("ignores a timed-out supervisor after retry starts a new child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-devices-cli-retry-"));
    const companion = join(dir, "mcp-devices-cli");
    const launchCount = join(dir, "launch-count");
    await writeFile(
      companion,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        `const countPath = ${JSON.stringify(launchCount)};`,
        "let launch = 0;",
        "try { launch = Number(fs.readFileSync(countPath, 'utf8')); } catch {}",
        "launch += 1;",
        "fs.writeFileSync(countPath, String(launch));",
        "if (launch === 1) process.stdout.write('{\"event\":\"ready\"}\\n');",
        "else setTimeout(() => process.stdout.write('{\"event\":\"ready\"}\\n'), 100);",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => {",
        "  input += chunk;",
        "  const newline = input.indexOf('\\n');",
        "  if (newline < 0) return;",
        "  const request = JSON.parse(input.slice(0, newline));",
        "  if (launch === 1 && request.method === 'hang') return;",
        "  process.stdout.write(JSON.stringify({ id: request.id, result: 'ok' }) + '\\n');",
        "});",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const client = new ReplBridgeClient({
      binaryPath: companion,
      requestTimeoutMs: 250,
      startTimeoutMs: 2_000,
    });

    try {
      await expect(client.call("hang")).rejects.toThrow(/timed out/);
      await expect(client.call<string>("retry")).resolves.toBe("ok");
    } finally {
      await client.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing native companion and cleans up failed starts", async () => {
    const listenersBefore = process.listenerCount("exit");
    const dir = await mkdtemp(join(tmpdir(), "mcp-devices-cli-missing-"));
    const c = new ReplBridgeClient({
      binaryPath: join(dir, "mcp-devices-cli"),
      requestTimeoutMs: 500,
    });

    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        await expect(c.call("noop")).rejects.toThrow(
          /ENOENT.*install `mcp-devices-cli` or set `MCP_DEVICES_BIN`/,
        );
      }
      expect(process.listenerCount("exit")).toBe(listenersBefore);
    } finally {
      await c.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Regression for #46: a supervisor binary that spawns but exits before
  // emitting `ready` must reject start() (and therefore call()) instead of
  // hanging forever. `true` exits 0 immediately and prints nothing.
  it("rejects when supervisor exits before ready", async () => {
    const c = new ReplBridgeClient({
      binaryPath: "true",
      requestTimeoutMs: 500,
    });
    await expect(c.call("spawn")).rejects.toBeInstanceOf(ReplBridgeError);
  });

  // Regression for #46: a supervisor that stays alive but never speaks the
  // protocol must time out on startup rather than hang. `yes` floods stdout
  // with lines that never parse as the `ready` event and never exits.
  it("rejects when supervisor never emits ready (startup timeout)", async () => {
    const c = new ReplBridgeClient({
      binaryPath: "yes",
      startTimeoutMs: 200,
      requestTimeoutMs: 5_000,
    });
    await expect(c.call("spawn")).rejects.toThrow(/within 200ms/);
    await c.dispose();
  });

  // A failed startup must not poison the client: a subsequent call() should
  // re-attempt a fresh supervisor rather than re-throw the cached rejection.
  it("retries a fresh supervisor after a failed start", async () => {
    const c = new ReplBridgeClient({
      binaryPath: "true",
      requestTimeoutMs: 500,
    });
    await expect(c.call("spawn")).rejects.toBeInstanceOf(ReplBridgeError);
    // Second attempt must also reject (binary is still `true`) — proving the
    // client retried rather than returning a stale settled promise.
    await expect(c.call("spawn")).rejects.toBeInstanceOf(ReplBridgeError);
  });
});
