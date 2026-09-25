import type { ToolDefinition } from "@mcp-devices/plugin-api";
import { describe, expect, it } from "vitest";

import { dummyContext } from "../contract-suite.js";
import { ReplPlugin } from "./index.js";
import { ReplBridgeClient } from "./client.js";
import type { SessionInfo, SessionSnapshot } from "./types.js";

/** Bridge stub that records calls and returns a canned result. */
class CapturingBridge extends ReplBridgeClient {
  calls: { method: string; params: unknown; timeoutMs?: number }[] = [];
  result: unknown = null;

  async start(): Promise<void> {}
  async call<T>(
    method: string,
    params: unknown = {},
    timeoutMs?: number
  ): Promise<T> {
    this.calls.push({ method, params, timeoutMs });
    return this.result as T;
  }
  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// expect timeout coupling (P2)
// ---------------------------------------------------------------------------

describe("ReplPlugin.expect timeout coupling (P2)", () => {
  it("extends the request timeout past the server-side expect timeout", async () => {
    const bridge = new CapturingBridge();
    const plugin = new ReplPlugin({ bridge });
    await plugin.expect({ id: "s", timeoutMs: 60_000 });
    expect(bridge.calls[0].timeoutMs).toBe(65_000);
  });

  it.each([
    [295_000, 300_000],
    [295_001, 300_001],
    [300_000, 305_000],
  ])(
    "accepts public timeout %i and preserves the bridge buffer (%i)",
    async (serverTimeout, requestTimeout) => {
      const bridge = new CapturingBridge();
      bridge.result = { kind: "timedOut" };
      const plugin = new ReplPlugin({ bridge });

      await expect(plugin.expect({ id: "s", timeoutMs: serverTimeout }))
        .resolves.toEqual({ kind: "timedOut" });
      expect(bridge.calls[0]).toMatchObject({
        method: "expect",
        timeoutMs: requestTimeout,
      });
    },
  );

  it("rejects public expect timeouts above 300,000ms before bridge dispatch", async () => {
    const bridge = new CapturingBridge();
    const plugin = new ReplPlugin({ bridge });

    await expect(plugin.expect({ id: "s", timeoutMs: 300_001 }))
      .rejects.toThrow("300000");
    expect(bridge.calls).toHaveLength(0);
  });

  it("rejects malformed public expect timing values before bridge dispatch", async () => {
    const bridge = new CapturingBridge();
    const plugin = new ReplPlugin({ bridge });

    for (const timeoutMs of [-1, 300_001, 1.5, null, "5000", true]) {
      await expect(
        plugin.expect({ id: "s", timeoutMs: timeoutMs as unknown as number }),
      ).rejects.toThrow("timeoutMs");
    }
    for (const idleMs of [-1, 60_001, 1.5, null, "300", true]) {
      await expect(
        plugin.expect({ id: "s", idleMs: idleMs as unknown as number }),
      ).rejects.toThrow("idleMs");
    }
    expect(bridge.calls).toHaveLength(0);
  });

  it("publishes bounded integer schemas for public expect timing", () => {
    const definitions: ToolDefinition[] = [];
    const plugin = new ReplPlugin({ bridge: new CapturingBridge() });
    plugin.init(dummyContext({ registerTool: (definition) => definitions.push(definition) }));

    const expectTool = definitions.find((definition) => definition.name === "repl_expect");
    expect(expectTool).toBeDefined();
    const properties = expectTool!.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.idleMs).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 60_000,
      default: 300,
    });
    expect(properties.timeoutMs).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: 300_000,
      default: 5_000,
    });
  });

  it("uses the 5s server default + buffer when timeoutMs is omitted", async () => {
    const bridge = new CapturingBridge();
    const plugin = new ReplPlugin({ bridge });
    await plugin.expect({ id: "s" });
    expect(bridge.calls[0].timeoutMs).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// list cmd redaction (P4)
// ---------------------------------------------------------------------------

describe("ReplPlugin.list cmd redaction (P4)", () => {
  const withSecret: SessionInfo[] = [
    {
      id: "s",
      cmd: "deploy --key sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA",
      status: "ready",
      exitCode: null,
    },
  ];

  it("redacts secrets in cmd by default", async () => {
    const bridge = new CapturingBridge();
    bridge.result = withSecret;
    const plugin = new ReplPlugin({ bridge });
    const out = await plugin.list();
    expect(out[0].cmd).toBe("deploy --key [REDACTED]");
  });

  it("redacts command-line password, token, api-key, and mysql secrets", async () => {
    const bridge = new CapturingBridge();
    bridge.result = [{
      id: "s2",
      cmd: "PASSWORD=pass-secret TOKEN=token-secret deploy --api-key api-secret mysql -pdb-secret",
      status: "ready",
      exitCode: null,
    }];
    const plugin = new ReplPlugin({ bridge });
    const out = await plugin.list();

    expect(out[0].cmd).not.toContain("pass-secret");
    expect(out[0].cmd).not.toContain("token-secret");
    expect(out[0].cmd).not.toContain("api-secret");
    expect(out[0].cmd).not.toContain("db-secret");
    expect(out[0].cmd).toContain("[REDACTED]");
  });

  it("leaves cmd untouched when redaction is disabled", async () => {
    const bridge = new CapturingBridge();
    bridge.result = withSecret;
    const plugin = new ReplPlugin({ bridge, disableRedaction: true });
    const out = await plugin.list();
    expect(out[0].cmd).toBe("deploy --key sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA");
  });
});

// ---------------------------------------------------------------------------
// snapshot — backward compat legacy shape (S1, S21, R10)
// ---------------------------------------------------------------------------

describe("ReplPlugin.snapshot backward compatibility (R10, S1, S21)", () => {
  const legacySnap: SessionSnapshot = {
    id: "s",
    status: "ready",
    screen: "$ hello",
    exitCode: null,
    cols: 120,
    rows: 40,
  };

  it("snapshot without mode returns legacy shape with no raw/frames (S1)", async () => {
    const bridge = new CapturingBridge();
    bridge.result = legacySnap;
    const plugin = new ReplPlugin({ bridge });
    const snap = await plugin.snapshot({ id: "s" });
    expect(snap.screen).toBe("$ hello");
    expect(snap.raw).toBeUndefined();
    expect(snap.frames).toBeUndefined();
    expect(snap.cols).toBe(120);
    expect(snap.rows).toBe(40);
  });

  it("forwards mode and history params to bridge call (R1)", async () => {
    const bridge = new CapturingBridge();
    bridge.result = { ...legacySnap, raw: "bytes", frames: [] };
    const plugin = new ReplPlugin({ bridge });
    await plugin.snapshot({ id: "s", mode: "both", history: 5 });
    expect(bridge.calls[0].params).toMatchObject({ mode: "both", history: 5 });
  });

  it("forwards history:true to bridge (R4)", async () => {
    const bridge = new CapturingBridge();
    bridge.result = { ...legacySnap, frames: [] };
    const plugin = new ReplPlugin({ bridge });
    await plugin.snapshot({ id: "s", history: true });
    expect(bridge.calls[0].params).toMatchObject({ history: true });
  });
});

// ---------------------------------------------------------------------------
// spawn — record / castFile (R6, S12, S13)
// ---------------------------------------------------------------------------

describe("ReplPlugin.spawn record (R6)", () => {
  it("forwards record:true to bridge and returns castFile (S12)", async () => {
    const bridge = new CapturingBridge();
    bridge.result = { id: "r1", castFile: "/tmp/r1.cast" };
    const plugin = new ReplPlugin({ bridge });
    const result = await plugin.spawn({ id: "r1", cmd: "bash", record: true });
    expect(bridge.calls[0].params).toMatchObject({ record: true });
    expect(result.castFile).toBe("/tmp/r1.cast");
    expect(result.id).toBe("r1");
  });

  it("returns only {id} when record is not set (S13)", async () => {
    const bridge = new CapturingBridge();
    bridge.result = { id: "r2" };
    const plugin = new ReplPlugin({ bridge });
    const result = await plugin.spawn({ id: "r2", cmd: "bash" });
    expect(result.castFile).toBeUndefined();
  });

  it("forwards record path string to bridge (R6)", async () => {
    const bridge = new CapturingBridge();
    bridge.result = { id: "r3", castFile: "/tmp/r3.cast" };
    const plugin = new ReplPlugin({ bridge });
    await plugin.spawn({ id: "r3", cmd: "bash", record: "/tmp/r3.cast" });
    expect(bridge.calls[0].params).toMatchObject({ record: "/tmp/r3.cast" });
  });
});
describe("ReplPlugin input bounds", () => {
  it("rejects oversized or malformed spawn fields before calling the bridge", async () => {
    const bridge = new CapturingBridge();
    const plugin = new ReplPlugin({ bridge });
    await expect(plugin.spawn({ id: "bad/id", cmd: "bash" })).rejects.toThrow("session id");
    await expect(
      plugin.spawn({ id: "bounded", cmd: "x".repeat(16 * 1024 + 1) }),
    ).rejects.toThrow("cmd");
    await expect(
      plugin.spawn({ id: "bounded", cmd: "bash", env: { "BAD-KEY": "x" } }),
    ).rejects.toThrow("environment variable name");
    await expect(
      plugin.spawn({ id: "bounded", cmd: "bash", promptRegex: "x".repeat(4 * 1024 + 1) }),
    ).rejects.toThrow("promptRegex");
    expect(bridge.calls).toHaveLength(0);
  });

  it("rejects oversized terminal input before calling the bridge", async () => {
    const bridge = new CapturingBridge();
    const plugin = new ReplPlugin({ bridge });
    await expect(
      plugin.send({ id: "valid-id", text: "x".repeat(64 * 1024 + 1) }),
    ).rejects.toThrow("text");
    expect(bridge.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resize — bridge call forwarding (R8, S17, S18, S19)
// ---------------------------------------------------------------------------

describe("ReplPlugin.resize (R8)", () => {
  it("forwards resize request to bridge with id/cols/rows (S17)", async () => {
    const bridge = new CapturingBridge();
    bridge.result = { ok: true };
    const plugin = new ReplPlugin({ bridge });
    const result = await plugin.resize({ id: "s", cols: 100, rows: 30 });
    expect(bridge.calls[0].method).toBe("resize");
    expect(bridge.calls[0].params).toEqual({ id: "s", cols: 100, rows: 30 });
    expect(result).toEqual({ ok: true });
  });

  it("propagates bridge error for unknown session (S18)", async () => {
    const bridge = new CapturingBridge();
    // The bridge call<T>() rejects with a ReplBridgeError when supervisor returns error.
    // Here we simulate via override.
    const errorBridge = new (class extends ReplBridgeClient {
      async start(): Promise<void> {}
      async call<T>(): Promise<T> {
        throw new Error("no session: missing");
      }
      async dispose(): Promise<void> {}
    })();
    const plugin = new ReplPlugin({ bridge: errorBridge });
    await expect(plugin.resize({ id: "missing", cols: 80, rows: 24 })).rejects.toThrow(
      "no session: missing"
    );
  });
});

// ---------------------------------------------------------------------------
// snapshot mode defense-in-depth — TS redaction on all surfaces (R2, S5)
// ---------------------------------------------------------------------------

describe("ReplPlugin.snapshot TS-side defense-in-depth redaction (R2)", () => {
  const TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";

  it("redacts raw field (mode:raw) in TS layer (S3, S5)", async () => {
    const bridge = new CapturingBridge();
    bridge.result = {
      id: "s",
      status: "ready",
      screen: "clean",
      exitCode: null,
      cols: 120,
      rows: 40,
      raw: `export TOKEN=${TOKEN}`,
    };
    const plugin = new ReplPlugin({ bridge });
    const snap = await plugin.snapshot({ id: "s", mode: "raw" });
    expect(snap.raw).not.toContain(TOKEN);
    expect(snap.raw).toContain("[REDACTED]");
  });
  it("redacts ANSI/OSC-split AWS and GitHub credentials from raw snapshots", async () => {
    const aws = "ASIAIOSFODNN7EXAMPLE";
    const github = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const bridge = new CapturingBridge();
    bridge.result = {
      id: "s",
      status: "ready",
      screen: "clean",
      exitCode: null,
      cols: 120,
      rows: 40,
      raw:
        `\u001b[32m${aws.slice(0, 4)}\u001b[0m${aws.slice(4)} ` +
        `${github.slice(0, 8)}\u001b]0;split\u0007${github.slice(8)}`,
    };
    const plugin = new ReplPlugin({ bridge });

    const snap = await plugin.snapshot({ id: "s", mode: "raw" });

    expect(snap.raw).not.toContain(aws);
    expect(snap.raw).not.toContain(github);
    expect(snap.raw).toContain("[REDACTED]");
    expect(snap.raw).toContain("\u001b[32m");
  });


  it("redacts all frames[].grid entries (S10)", async () => {
    const bridge = new CapturingBridge();
    bridge.result = {
      id: "s",
      status: "ready",
      screen: "clean",
      exitCode: null,
      cols: 120,
      rows: 40,
      frames: [
        { ts: 1000, grid: `$ echo ${TOKEN}` },
        { ts: 2000, grid: "$ ls" },
      ],
    };
    const plugin = new ReplPlugin({ bridge });
    const snap = await plugin.snapshot({ id: "s", history: 2 });
    expect(snap.frames).toHaveLength(2);
    expect(snap.frames![0].grid).not.toContain(TOKEN);
    expect(snap.frames![0].grid).toContain("[REDACTED]");
    expect(snap.frames![1].grid).toBe("$ ls");
  });

  it("returns frames:[] when history requested but no frames captured (S11)", async () => {
    const bridge = new CapturingBridge();
    bridge.result = {
      id: "s",
      status: "ready",
      screen: "$ ",
      exitCode: null,
      cols: 120,
      rows: 40,
      frames: [],
    };
    const plugin = new ReplPlugin({ bridge });
    const snap = await plugin.snapshot({ id: "s", history: 5 });
    expect(snap.frames).toBeDefined();
    expect(snap.frames).toHaveLength(0);
  });
});
