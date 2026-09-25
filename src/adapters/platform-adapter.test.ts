import { describe, expect, it, vi } from "vitest";
import { hasHeapSnapshot, requireHeapSnapshot } from "./platform-adapter.js";
import type { CorePlatformAdapter } from "./platform-adapter.js";

function heapAdapter(format: unknown, captureHeapSnapshot: unknown): CorePlatformAdapter {
  return {
    platform: "web",
    heapSnapshotFormat: format,
    captureHeapSnapshot,
  } as unknown as CorePlatformAdapter;
}

describe("heap snapshot capability", () => {
  it("accepts a declared format and capture method", () => {
    const adapter = heapAdapter("chrome-heapsnapshot", vi.fn());

    expect(hasHeapSnapshot(adapter)).toBe(true);
    expect(requireHeapSnapshot(adapter)).toBe(adapter);
  });

  it("rejects missing methods and unsupported formats", () => {
    expect(hasHeapSnapshot(heapAdapter("chrome-heapsnapshot", undefined))).toBe(false);
    expect(hasHeapSnapshot(heapAdapter("unknown", vi.fn()))).toBe(false);
  });
});
