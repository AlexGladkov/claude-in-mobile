import { describe, it, expect } from "vitest";
import { formatUiLine, truncateResponse, formatLiteError, MAX_UI_ELEMENTS, MAX_RESPONSE_CHARS } from "./formatter.js";

describe("Lite Formatter", () => {
  describe("formatUiLine", () => {
    it("should format Android UI dump line", () => {
      const line = '<node text="Login" class="android.widget.Button" bounds="[100,300][200,400]">';
      const result = formatUiLine(0, line);
      expect(result).toBe('[0] "Login" Button (150,350)');
    });

    it("should handle line without text", () => {
      const line = '<node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">';
      const result = formatUiLine(1, line);
      expect(result).toBe("[1] FrameLayout (540,1200)");
    });

    it("should fallback to truncated raw for unparseable lines", () => {
      const line = "some random line without any recognizable format";
      const result = formatUiLine(2, line);
      expect(result).toContain("[2]");
      expect(result.length).toBeLessThanOrEqual(85); // [idx] + 80 chars
    });
  });

  describe("MAX_UI_ELEMENTS", () => {
    it("should be 15", () => {
      expect(MAX_UI_ELEMENTS).toBe(15);
    });
  });

  describe("MAX_RESPONSE_CHARS", () => {
    it("should be 5000", () => {
      expect(MAX_RESPONSE_CHARS).toBe(5_000);
    });
  });

  describe("truncateResponse", () => {
    it("should not truncate short text", () => {
      const text = "Short response";
      expect(truncateResponse(text)).toBe(text);
    });

    it("should truncate long text", () => {
      const text = "x".repeat(6000);
      const result = truncateResponse(text);
      expect(result.length).toBeLessThan(6000);
      expect(result).toContain("[truncated");
      expect(result).toContain("1000 chars remaining");
    });
  });

  describe("formatLiteError", () => {
    it("should format error with code and first sentence", () => {
      const result = formatLiteError("DEVICE_NOT_FOUND", "Device not found: abc123. Use device list to see connected.");
      expect(result).toBe("[DEVICE_NOT_FOUND] Device not found: abc123");
    });

    it("should handle single sentence error", () => {
      const result = formatLiteError("UNKNOWN", "Something went wrong");
      expect(result).toBe("[UNKNOWN] Something went wrong");
    });
  });
});
