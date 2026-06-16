import { describe, expect, it } from "vitest";

import { ReplPlugin } from "./index.js";
import { ReplBridgeClient } from "./client.js";
import type { SessionInfo } from "./types.js";

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

describe("ReplPlugin.expect timeout coupling (P2)", () => {
  it("extends the request timeout past the server-side expect timeout", async () => {
    const bridge = new CapturingBridge();
    const plugin = new ReplPlugin({ bridge });
    await plugin.expect({ id: "s", timeoutMs: 60_000 });
    expect(bridge.calls[0].timeoutMs).toBe(65_000);
  });

  it("uses the 5s server default + buffer when timeoutMs is omitted", async () => {
    const bridge = new CapturingBridge();
    const plugin = new ReplPlugin({ bridge });
    await plugin.expect({ id: "s" });
    expect(bridge.calls[0].timeoutMs).toBe(10_000);
  });
});

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

  it("leaves cmd untouched when redaction is disabled", async () => {
    const bridge = new CapturingBridge();
    bridge.result = withSecret;
    const plugin = new ReplPlugin({ bridge, disableRedaction: true });
    const out = await plugin.list();
    expect(out[0].cmd).toBe("deploy --key sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA");
  });
});
