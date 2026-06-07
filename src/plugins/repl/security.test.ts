/**
 * Security baseline contract for the REPL plugin.
 *
 * These tests encode the invariants from docs/security.md. Removing one
 * requires updating the document and an ADR.
 */

import { describe, expect, it } from "vitest";

import { REDACTION_PATTERNS, redactScreen } from "./redaction.js";

describe("REPL security baseline", () => {
  it("redaction covers all required credential families", () => {
    const required = new Set([
      "aws-access-key",
      "github-pat",
      "anthropic-key",
      "openai-key",
      "bearer-token",
      "jwt",
      "google-api-key",
      "slack-token",
    ]);
    const present = new Set(REDACTION_PATTERNS.map((p) => p.name));
    for (const name of required) {
      expect(present.has(name)).toBe(true);
    }
  });

  it("known token shapes are redacted in a single pass", () => {
    const samples = [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx",
      "AIzaSyA-FAKE-EXAMPLE-KEY-A1B2C3D4E5F6G7H",
      "xoxb-1234567890-fake-slack-token",
    ];
    const out = redactScreen(samples.join("\n"));
    for (const s of samples) {
      expect(out).not.toContain(s);
    }
  });

  it("redactScreen never throws on empty or huge input", () => {
    expect(redactScreen("")).toBe("");
    const big = "x".repeat(100_000);
    expect(() => redactScreen(big)).not.toThrow();
  });
});
