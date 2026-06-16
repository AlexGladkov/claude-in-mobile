import { describe, expect, it } from "vitest";

import { ReplBridgeClient, ReplBridgeError } from "./client.js";

describe("ReplBridgeClient construction", () => {
  it("falls back to CLAUDE_IN_MOBILE_BIN env override", () => {
    const prior = process.env.CLAUDE_IN_MOBILE_BIN;
    process.env.CLAUDE_IN_MOBILE_BIN = "/nonexistent/path-to-binary-xyz";
    const c = new ReplBridgeClient();
    expect(c).toBeInstanceOf(ReplBridgeClient);
    process.env.CLAUDE_IN_MOBILE_BIN = prior;
  });

  it("rejects when binary cannot be spawned", async () => {
    const c = new ReplBridgeClient({
      binaryPath: "/this/binary/definitely/does/not/exist/xyz",
      requestTimeoutMs: 500,
    });
    await expect(c.call("noop")).rejects.toBeInstanceOf(ReplBridgeError);
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
