import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolMetricsCollector, getGlobalMetrics } from "./metrics.js";

// ──────────────────────────────────────────────
// ToolMetricsCollector
// ──────────────────────────────────────────────

describe("ToolMetricsCollector", () => {
  let collector: ToolMetricsCollector;

  beforeEach(() => {
    collector = new ToolMetricsCollector();
  });

  // ──────────────────────────────────────────
  // record()
  // ──────────────────────────────────────────

  describe("record", () => {
    it("records a single successful call", () => {
      collector.record("tap", 150, false);
      const summary = collector.getSummary();
      expect(summary["tap"]).toBeDefined();
      expect(summary["tap"].calls).toBe(1);
      expect(summary["tap"].errors).toBe(0);
      expect(summary["tap"].totalMs).toBe(150);
    });

    it("records a single error call", () => {
      collector.record("tap", 200, true);
      const summary = collector.getSummary();
      expect(summary["tap"].calls).toBe(1);
      expect(summary["tap"].errors).toBe(1);
      expect(summary["tap"].totalMs).toBe(200);
    });

    it("accumulates multiple calls for the same tool", () => {
      collector.record("swipe", 100, false);
      collector.record("swipe", 200, false);
      collector.record("swipe", 300, true);
      const summary = collector.getSummary();
      expect(summary["swipe"].calls).toBe(3);
      expect(summary["swipe"].errors).toBe(1);
      expect(summary["swipe"].totalMs).toBe(600);
    });

    it("tracks different tools independently", () => {
      collector.record("tap", 50, false);
      collector.record("swipe", 100, true);
      collector.record("screenshot", 500, false);
      const summary = collector.getSummary();
      expect(Object.keys(summary)).toHaveLength(3);
      expect(summary["tap"].calls).toBe(1);
      expect(summary["swipe"].calls).toBe(1);
      expect(summary["screenshot"].calls).toBe(1);
    });

    it("sets lastCallAt to approximately Date.now()", () => {
      const before = Date.now();
      collector.record("tap", 100, false);
      const after = Date.now();
      const summary = collector.getSummary();
      expect(summary["tap"].lastCallAt).toBeGreaterThanOrEqual(before);
      expect(summary["tap"].lastCallAt).toBeLessThanOrEqual(after);
    });

    it("updates lastCallAt on subsequent calls", () => {
      collector.record("tap", 100, false);
      const first = collector.getSummary()["tap"].lastCallAt;

      // Small delay to ensure different timestamp
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      collector.record("tap", 200, false);
      const second = collector.getSummary()["tap"].lastCallAt;
      expect(second).toBeGreaterThanOrEqual(first);
    });
  });

  // ──────────────────────────────────────────
  // getSummary()
  // ──────────────────────────────────────────

  describe("getSummary", () => {
    it("returns empty object when no calls recorded", () => {
      const summary = collector.getSummary();
      expect(summary).toEqual({});
    });

    it("returns a deep copy (mutation-safe)", () => {
      collector.record("tap", 100, false);
      const summary1 = collector.getSummary();
      summary1["tap"].calls = 999;
      const summary2 = collector.getSummary();
      expect(summary2["tap"].calls).toBe(1); // original unmodified
    });

    it("includes all recorded tools", () => {
      collector.record("tap", 100, false);
      collector.record("swipe", 200, false);
      collector.record("screenshot", 300, false);
      const summary = collector.getSummary();
      expect(Object.keys(summary).sort()).toEqual(["screenshot", "swipe", "tap"]);
    });
  });

  // ──────────────────────────────────────────
  // getFormatted()
  // ──────────────────────────────────────────

  describe("getFormatted", () => {
    it("returns 'No tool calls recorded.' when empty", () => {
      expect(collector.getFormatted()).toBe("No tool calls recorded.");
    });

    it("formats a single tool entry", () => {
      collector.record("tap", 150, false);
      const formatted = collector.getFormatted();
      expect(formatted).toContain("Tool metrics:");
      expect(formatted).toContain("tap");
      expect(formatted).toContain("1 calls");
      expect(formatted).toContain("avg 150ms");
      expect(formatted).toContain("errors 0 (0%)");
      expect(formatted).toContain("Total: 1 calls, 0 errors");
    });

    it("calculates correct average duration", () => {
      collector.record("swipe", 100, false);
      collector.record("swipe", 200, false);
      collector.record("swipe", 300, false);
      const formatted = collector.getFormatted();
      // Average of 100+200+300 = 600/3 = 200
      expect(formatted).toContain("avg 200ms");
    });

    it("calculates correct error rate", () => {
      collector.record("tap", 100, true);
      collector.record("tap", 100, true);
      collector.record("tap", 100, false);
      collector.record("tap", 100, false);
      const formatted = collector.getFormatted();
      // 2 errors out of 4 calls = 50%
      expect(formatted).toContain("errors 2 (50%)");
    });

    it("shows 100% error rate when all calls fail", () => {
      collector.record("fail_tool", 100, true);
      collector.record("fail_tool", 200, true);
      const formatted = collector.getFormatted();
      expect(formatted).toContain("errors 2 (100%)");
    });

    it("sorts tools by call count descending", () => {
      collector.record("rare", 100, false);
      collector.record("common", 100, false);
      collector.record("common", 100, false);
      collector.record("common", 100, false);
      collector.record("medium", 100, false);
      collector.record("medium", 100, false);

      const formatted = collector.getFormatted();
      const commonIdx = formatted.indexOf("common");
      const mediumIdx = formatted.indexOf("medium");
      const rareIdx = formatted.indexOf("rare");
      expect(commonIdx).toBeLessThan(mediumIdx);
      expect(mediumIdx).toBeLessThan(rareIdx);
    });

    it("shows correct total counts", () => {
      collector.record("tap", 100, false);
      collector.record("tap", 100, true);
      collector.record("swipe", 200, false);
      collector.record("screenshot", 300, true);
      const formatted = collector.getFormatted();
      expect(formatted).toContain("Total: 4 calls, 2 errors");
    });

    it("rounds average duration to integer", () => {
      collector.record("tap", 101, false);
      collector.record("tap", 102, false);
      collector.record("tap", 100, false);
      const formatted = collector.getFormatted();
      // Average = 303/3 = 101
      expect(formatted).toContain("avg 101ms");
    });
  });

  // ──────────────────────────────────────────
  // reset()
  // ──────────────────────────────────────────

  describe("reset", () => {
    it("clears all recorded metrics", () => {
      collector.record("tap", 100, false);
      collector.record("swipe", 200, true);
      collector.reset();
      const summary = collector.getSummary();
      expect(summary).toEqual({});
    });

    it("results in 'No tool calls recorded.' after reset", () => {
      collector.record("tap", 100, false);
      collector.reset();
      expect(collector.getFormatted()).toBe("No tool calls recorded.");
    });

    it("allows recording again after reset", () => {
      collector.record("tap", 100, false);
      collector.reset();
      collector.record("swipe", 200, false);
      const summary = collector.getSummary();
      expect(Object.keys(summary)).toEqual(["swipe"]);
      expect(summary["swipe"].calls).toBe(1);
    });
  });
});

// ──────────────────────────────────────────────
// getGlobalMetrics (singleton)
// ──────────────────────────────────────────────

describe("getGlobalMetrics", () => {
  it("returns a ToolMetricsCollector instance", () => {
    const metrics = getGlobalMetrics();
    expect(metrics).toBeInstanceOf(ToolMetricsCollector);
  });

  it("returns the same instance on multiple calls (singleton)", () => {
    const first = getGlobalMetrics();
    const second = getGlobalMetrics();
    expect(first).toBe(second);
  });

  it("singleton instance records and retrieves metrics", () => {
    const metrics = getGlobalMetrics();
    metrics.reset(); // clean state
    metrics.record("global_test", 42, false);
    const summary = metrics.getSummary();
    expect(summary["global_test"]).toBeDefined();
    expect(summary["global_test"].calls).toBe(1);
    metrics.reset(); // clean up
  });
});
