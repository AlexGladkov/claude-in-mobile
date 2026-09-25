/**
 * Security baseline contract for the REPL plugin.
 *
 * These tests encode the invariants from docs/security.md. Removing one
 * requires updating the document and an ADR.
 *
 * Rust parity anchor: cli/src/plugins/repl/redaction.rs REDACTION_PATTERNS
 * must list the same pattern names as the EXPECTED_PATTERN_NAMES array below.
 * When adding a pattern, update BOTH sides and the SHARED_SECRET_SAMPLES
 * fixture. See also tests/fixtures/secret-samples.txt (used by Rust parity tests).
 */

import { describe, expect, it } from "vitest";

import { REDACTION_PATTERNS, redactScreen } from "./redaction.js";
import { ReplPlugin } from "./index.js";
import { ReplBridgeClient } from "./client.js";
import type { SessionSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Shared constants — must stay in sync with:
//  - cli/src/plugins/repl/redaction.rs REDACTION_PATTERNS (Rust parity)
//  - tests/fixtures/secret-samples.txt (Rust behaviour-parity tests)
// ---------------------------------------------------------------------------

/**
 * Canonical list of pattern names. When a new pattern is added on an incident
 * in one language (TS or Rust), this guard ensures the other side cannot
 * silently lag (R15, S27).
 *
 * NOTE: aws-secret is intentionally omitted here because it overlaps so
 * broadly with arbitrary base64 that it is tested via behaviour (samples)
 * rather than by name parity alone. The Rust side uses a boundary-anchor
 * rewrite without lookbehind (regex 1.10 lacks it).
 */
export const EXPECTED_PATTERN_NAMES = [
  "aws-access-key",
  "aws-secret",
  "github-pat",
  "anthropic-key",
  "openai-key",
  "bearer-token",
  "jwt",
  "google-api-key",
  "slack-token",
] as const;

/**
 * Shared fixture of real token shapes that MUST be redacted by both TS and
 * Rust redactors. This mirrors tests/fixtures/secret-samples.txt used by the
 * Rust parity tests (cli/src/plugins/repl/redaction.rs).
 *
 * Each sample is a complete recognizable token form (not arbitrary data).
 * The aws-secret sample is a 40-char base64-range string bounded by spaces
 * so boundary detection works on both sides.
 */
export const SHARED_SECRET_SAMPLES: readonly string[] = [
  // aws-access-key
  "AKIAIOSFODNN7EXAMPLE",
  "ASIAIOSFODNN7EXAMPLE",
  "AIDAIOSFODNN7EXAMPLE",
  "AROAIOSFODNN7EXAMPLE",
  "AGPAIOSFODNN7EXAMPLE",
  "AIPAIOSFODNN7EXAMPLE",
  "ANPAIOSFODNN7EXAMPLE",
  "ANVAIOSFODNN7EXAMPLE",
  "ASCAIOSFODNN7EXAMPLE",
  "ACCAIOSFODNN7EXAMPLE",
  "ABIAIOSFODNN7EXAMPLE",
  "A3TBIOSFODNN7EXAMPLE",
  // aws-secret (40-char, bounded — space on both sides for Rust boundary rewrite)
  " wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY ",
  // github-pat (all variants)
  "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
  "gho_1234567890abcdefghijklmnopqrstuvwxyz",
  "ghu_1234567890abcdefghijklmnopqrstuvwxyz",
  // anthropic-key
  "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx",
  // openai-key (sk- prefix, alphanumeric body — pattern: sk-[A-Za-z0-9]{20,})
  "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  // bearer-token
  "Bearer abc.def.ghi",
  // jwt
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart",
  // google-api-key (AIza + 35 chars = 39 total, pattern: AIza[0-9A-Za-z\\-_]{35})
  "AIzaSyA-FAKE-EXAMPLE-KEY-A1B2C3D4E5F6G7",
  // slack-token
  "xoxb-1234567890-fake-slack-token",
];

// ---------------------------------------------------------------------------
// Bridge stub for TS-side snapshot redaction tests
// ---------------------------------------------------------------------------

class StubBridge extends ReplBridgeClient {
  constructor(private readonly result: unknown) {
    super();
  }
  async start(): Promise<void> {}
  async call<T>(): Promise<T> {
    return this.result as T;
  }
  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Pattern set parity (R15, S27)
// ---------------------------------------------------------------------------

describe("REPL security baseline — pattern set", () => {
  it("redaction covers all required credential families (R2)", () => {
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

  it("pattern names match EXPECTED_PATTERN_NAMES — Rust parity guard (R15)", () => {
    // Rust parity: cli/src/plugins/repl/redaction.rs REDACTION_PATTERNS must
    // list the same names. If either side adds a name and not the other,
    // this test turns red.
    const present = new Set(REDACTION_PATTERNS.map((p) => p.name));
    for (const name of EXPECTED_PATTERN_NAMES) {
      expect(present.has(name), `Pattern '${name}' missing from TS REDACTION_PATTERNS`).toBe(true);
    }
    // Reverse: no extra names in TS that Rust doesn't know about
    expect(REDACTION_PATTERNS.length).toBe(EXPECTED_PATTERN_NAMES.length);
  });
});

// ---------------------------------------------------------------------------
// Behaviour parity on shared fixture (R15, S27)
// ---------------------------------------------------------------------------

describe("REPL security baseline — behaviour parity on shared fixture", () => {
  it("every SHARED_SECRET_SAMPLES entry is fully redacted by TS redactScreen (S27)", () => {
    for (const sample of SHARED_SECRET_SAMPLES) {
      const out = redactScreen(sample);
      // The token itself must not appear literally in the output.
      // Trim the sample to strip boundary-padding spaces used for Rust tests.
      const token = sample.trim();
      expect(out, `Sample not redacted: ${token.slice(0, 30)}...`).not.toContain(token);
      expect(out).toContain("[REDACTED]");
    }
  });

  it("known token shapes are redacted in a single pass (S27)", () => {
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

// ---------------------------------------------------------------------------
// Snapshot redaction — all surfaces (R2, S5)
// ---------------------------------------------------------------------------

describe("REPL security baseline — snapshot surface redaction", () => {
  const TOKEN = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx";
  const BEARER = "Bearer abc.def.ghi";

  function makeSnap(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
    return {
      id: "s1",
      status: "ready",
      screen: `prompt> export KEY=${TOKEN}`,
      exitCode: null,
      cols: 120,
      rows: 40,
      ...overrides,
    };
  }

  it("redacts screen field (baseline — S1)", async () => {
    const bridge = new StubBridge(makeSnap());
    const plugin = new ReplPlugin({ bridge });
    const snap = await plugin.snapshot({ id: "s1" });
    expect(snap.screen).not.toContain(TOKEN);
    expect(snap.screen).toContain("[REDACTED]");
  });

  it("redacts raw field when mode:raw (S3, S5)", async () => {
    const bridge = new StubBridge(
      makeSnap({ raw: `\x1b[1mexport KEY=${TOKEN}\x1b[0m` })
    );
    const plugin = new ReplPlugin({ bridge });
    const snap = await plugin.snapshot({ id: "s1", mode: "raw" });
    expect(snap.raw).toBeDefined();
    expect(snap.raw).not.toContain(TOKEN);
    expect(snap.raw).toContain("[REDACTED]");
  });

  it("redacts both screen and raw when mode:both (S2, S5)", async () => {
    const bridge = new StubBridge(
      makeSnap({
        screen: `KEY=${TOKEN}`,
        raw: `export ${BEARER}\r\n`,
      })
    );
    const plugin = new ReplPlugin({ bridge });
    const snap = await plugin.snapshot({ id: "s1", mode: "both" });
    // screen
    expect(snap.screen).not.toContain(TOKEN);
    expect(snap.screen).toContain("[REDACTED]");
    // raw
    expect(snap.raw).toBeDefined();
    expect(snap.raw).not.toContain("abc.def.ghi");
    expect(snap.raw).toContain("[REDACTED]");
  });

  it("redacts every frames[].grid entry when history truthy (S10, S6)", async () => {
    const frames = [
      { ts: 1000, grid: `frame1 ${TOKEN}` },
      { ts: 2000, grid: `frame2 ${BEARER}` },
      { ts: 3000, grid: "frame3 clean" },
    ];
    const bridge = new StubBridge(makeSnap({ frames }));
    const plugin = new ReplPlugin({ bridge });
    const snap = await plugin.snapshot({ id: "s1", history: true });
    expect(snap.frames).toHaveLength(3);
    for (const f of snap.frames!) {
      expect(f.grid).not.toContain(TOKEN);
      expect(f.grid).not.toContain("abc.def.ghi");
    }
    expect(snap.frames![0].grid).toContain("[REDACTED]");
    expect(snap.frames![1].grid).toContain("[REDACTED]");
    expect(snap.frames![2].grid).toBe("frame3 clean");
  });

  it("leaves raw/frames undefined when bridge omits them (S1 backward compat)", async () => {
    const bridge = new StubBridge(makeSnap());
    const plugin = new ReplPlugin({ bridge });
    const snap = await plugin.snapshot({ id: "s1" });
    expect(snap.raw).toBeUndefined();
    expect(snap.frames).toBeUndefined();
  });

  it("returns frames:[] when bridge returns empty array (S11)", async () => {
    const bridge = new StubBridge(makeSnap({ frames: [] }));
    const plugin = new ReplPlugin({ bridge });
    const snap = await plugin.snapshot({ id: "s1", history: true });
    expect(snap.frames).toBeDefined();
    expect(snap.frames).toHaveLength(0);
  });

  it("does NOT redact when disableRedaction:true (S21 gate for test scaffolding)", async () => {
    const bridge = new StubBridge(
      makeSnap({
        raw: `KEY=${TOKEN}`,
        frames: [{ ts: 1000, grid: `BEARER ${BEARER}` }],
      })
    );
    const plugin = new ReplPlugin({ bridge, disableRedaction: true });
    const snap = await plugin.snapshot({ id: "s1", mode: "both", history: 5 });
    expect(snap.screen).toContain(TOKEN);
    expect(snap.raw).toContain(TOKEN);
    expect(snap.frames![0].grid).toContain("abc.def.ghi");
  });
});

// ---------------------------------------------------------------------------
// Spawn result — castFile presence/absence (R6, S12, S13)
// ---------------------------------------------------------------------------

describe("REPL security baseline — spawn castFile field", () => {
  it("spawn without record returns only {id} (S13)", async () => {
    const bridge = new StubBridge({ id: "sess1" });
    const plugin = new ReplPlugin({ bridge });
    const result = await plugin.spawn({ id: "sess1", cmd: "bash" });
    expect(result.id).toBe("sess1");
    expect(result.castFile).toBeUndefined();
  });

  it("spawn with record:true returns {id, castFile} (S12)", async () => {
    const bridge = new StubBridge({
      id: "sess2",
      castFile: "/tmp/sess2.cast",
    });
    const plugin = new ReplPlugin({ bridge });
    const result = await plugin.spawn({ id: "sess2", cmd: "bash", record: true });
    expect(result.id).toBe("sess2");
    expect(result.castFile).toBe("/tmp/sess2.cast");
  });
});
