import { describe, it, expect } from "vitest";
import { truncateOutput } from "./truncate.js";

// ──────────────────────────────────────────────
// truncateOutput
// ──────────────────────────────────────────────

describe("truncateOutput", () => {
  // ──────────────────────────────────────────
  // Passthrough (no truncation)
  // ──────────────────────────────────────────

  describe("passthrough for short text", () => {
    it("returns short text unchanged", () => {
      const text = "Hello, world!";
      expect(truncateOutput(text)).toBe(text);
    });

    it("returns single-line text unchanged when within limits", () => {
      const text = "a".repeat(100);
      expect(truncateOutput(text)).toBe(text);
    });

    it("returns multi-line text unchanged when within both limits", () => {
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
      const text = lines.join("\n");
      expect(truncateOutput(text)).toBe(text);
    });

    it("returns text at exactly the default char limit unchanged", () => {
      const text = "x".repeat(10_000);
      expect(truncateOutput(text)).toBe(text);
    });

    it("returns text at exactly the default line limit unchanged", () => {
      const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}`);
      const text = lines.join("\n");
      expect(truncateOutput(text)).toBe(text);
    });
  });

  // ──────────────────────────────────────────
  // Empty / falsy input
  // ──────────────────────────────────────────

  describe("empty and falsy input", () => {
    it("returns empty string unchanged", () => {
      expect(truncateOutput("")).toBe("");
    });

    it("returns undefined as-is (falsy check)", () => {
      // The function checks `if (!text) return text`
      // undefined and null would pass through
      expect(truncateOutput(undefined as unknown as string)).toBeUndefined();
    });

    it("returns null as-is (falsy check)", () => {
      expect(truncateOutput(null as unknown as string)).toBeNull();
    });
  });

  // ──────────────────────────────────────────
  // Line limit truncation
  // ──────────────────────────────────────────

  describe("line limit truncation", () => {
    it("truncates text exceeding default line limit (200)", () => {
      const lines = Array.from({ length: 300 }, (_, i) => `Line ${i}`);
      const text = lines.join("\n");
      const result = truncateOutput(text);
      expect(result).toContain("[truncated,");
      expect(result).toContain("chars remaining]");
      // Should contain exactly the first 200 lines
      const resultLines = result.split("\n");
      expect(resultLines[0]).toBe("Line 0");
      expect(resultLines[199]).toBe("Line 199");
    });

    it("truncates with custom line limit", () => {
      const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
      const text = lines.join("\n");
      const result = truncateOutput(text, { maxLines: 5 });
      expect(result).toContain("[truncated,");
      const contentPart = result.split("\n\n[truncated")[0];
      const contentLines = contentPart.split("\n");
      expect(contentLines).toHaveLength(5);
      expect(contentLines[0]).toBe("L0");
      expect(contentLines[4]).toBe("L4");
    });

    it("includes correct remaining char count in marker", () => {
      const lines = Array.from({ length: 10 }, () => "abcde"); // 5 chars per line
      const text = lines.join("\n"); // "abcde\nabcde\n..." = 10*5 + 9 newlines = 59 chars
      const result = truncateOutput(text, { maxLines: 3, maxChars: 100_000 });
      // After truncating to 3 lines: "abcde\nabcde\nabcde" = 17 chars
      const remaining = text.length - 17;
      expect(result).toContain(`[truncated, ${remaining} chars remaining]`);
    });
  });

  // ──────────────────────────────────────────
  // Character limit truncation
  // ──────────────────────────────────────────

  describe("character limit truncation", () => {
    it("truncates text exceeding default char limit (10000)", () => {
      const text = "x".repeat(15_000);
      const result = truncateOutput(text);
      expect(result).toContain("[truncated,");
      expect(result).toContain("5000 chars remaining]");
    });

    it("truncates with custom char limit", () => {
      const text = "abcdefghij"; // 10 chars
      const result = truncateOutput(text, { maxChars: 5 });
      expect(result).toContain("abcde");
      expect(result).toContain("[truncated, 5 chars remaining]");
    });

    it("single long line triggers char truncation", () => {
      const text = "z".repeat(500);
      const result = truncateOutput(text, { maxChars: 100, maxLines: 1000 });
      expect(result).toContain("[truncated, 400 chars remaining]");
    });
  });

  // ──────────────────────────────────────────
  // Both limits applied
  // ──────────────────────────────────────────

  describe("both limits applied (lines first, then chars)", () => {
    it("applies line limit first then char limit", () => {
      // 50 lines of 100 chars each
      const lines = Array.from({ length: 50 }, () => "a".repeat(100));
      const text = lines.join("\n");
      // Set maxLines=10, maxChars=500
      const result = truncateOutput(text, { maxLines: 10, maxChars: 500 });
      expect(result).toContain("[truncated,");
      // After 10 lines: "aaa...\naaa..." = 10*100 + 9 newlines = 1009 chars
      // After char limit: 500 chars
      const contentPart = result.split("\n\n[truncated")[0];
      expect(contentPart.length).toBeLessThanOrEqual(500);
    });

    it("only line truncation when chars are within limit after line cut", () => {
      // 20 short lines
      const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
      const text = lines.join("\n");
      const result = truncateOutput(text, { maxLines: 5, maxChars: 100_000 });
      expect(result).toContain("[truncated,");
      const contentPart = result.split("\n\n[truncated")[0];
      const contentLines = contentPart.split("\n");
      expect(contentLines).toHaveLength(5);
    });
  });

  // ──────────────────────────────────────────
  // Custom options
  // ──────────────────────────────────────────

  describe("custom options", () => {
    it("respects maxChars option", () => {
      const text = "a".repeat(200);
      const result = truncateOutput(text, { maxChars: 50 });
      const contentPart = result.split("\n\n[truncated")[0];
      expect(contentPart.length).toBe(50);
    });

    it("respects maxLines option", () => {
      const lines = Array.from({ length: 100 }, () => "line");
      const text = lines.join("\n");
      const result = truncateOutput(text, { maxLines: 10 });
      const contentPart = result.split("\n\n[truncated")[0];
      expect(contentPart.split("\n")).toHaveLength(10);
    });

    it("uses defaults when options are undefined", () => {
      const text = "x".repeat(10_001);
      const result = truncateOutput(text, {});
      expect(result).toContain("[truncated, 1 chars remaining]");
    });

    it("large limits effectively disable truncation", () => {
      const text = "a".repeat(5000);
      const result = truncateOutput(text, { maxChars: 1_000_000, maxLines: 1_000_000 });
      expect(result).toBe(text);
    });
  });

  // ──────────────────────────────────────────
  // Marker format
  // ──────────────────────────────────────────

  describe("truncation marker format", () => {
    it("marker format is [truncated, N chars remaining]", () => {
      const text = "a".repeat(100);
      const result = truncateOutput(text, { maxChars: 30 });
      expect(result).toMatch(/\[truncated, \d+ chars remaining\]$/);
    });

    it("marker is separated by double newline", () => {
      const text = "a".repeat(100);
      const result = truncateOutput(text, { maxChars: 30 });
      expect(result).toContain("\n\n[truncated,");
    });

    it("no marker when text is not truncated", () => {
      const text = "short";
      const result = truncateOutput(text);
      expect(result).not.toContain("[truncated");
    });
  });
});
