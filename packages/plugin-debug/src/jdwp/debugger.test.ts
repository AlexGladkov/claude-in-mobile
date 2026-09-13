import { describe, expect, it } from "vitest";

import { JdwpDebugger } from "./debugger.js";
import type { DebugEvent } from "./debugger.js";
import type { JdwpSession } from "./session.js";

interface DebuggerHarness {
  events: DebugEvent[];
  pushEvent(event: Omit<DebugEvent, "cursor"> & { resolved?: boolean }): void;
}

function debuggerHarness(): { debugger: JdwpDebugger; harness: DebuggerHarness } {
  const session = {
    connection: {},
    idSizes: {
      fieldIDSize: 8,
      methodIDSize: 8,
      objectIDSize: 8,
      referenceTypeIDSize: 8,
      frameIDSize: 8,
    },
    connected: true,
    onEvent: () => {},
    onClose: () => {},
  } as unknown as JdwpSession;
  const debuggerInstance = new JdwpDebugger(session);
  return {
    debugger: debuggerInstance,
    harness: debuggerInstance as unknown as DebuggerHarness,
  };
}

describe("JdwpDebugger event retention", () => {
  it("bounds retained events while preserving absolute poll cursors", async () => {
    const { debugger: debuggerInstance, harness } = debuggerHarness();
    for (let index = 0; index < 1_100; index += 1) {
      harness.pushEvent({ kind: "BREAKPOINT_HIT", resolved: true });
    }

    expect(harness.events).toHaveLength(1_024);
    const result = await debuggerInstance.poll(0);
    expect(result.events).toHaveLength(1_024);
    expect(result.events[0]?.cursor).toBe(76);
    expect(result.nextCursor).toBe(1_100);
  });
});
