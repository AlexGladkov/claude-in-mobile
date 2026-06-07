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
});
