import { describe, expect, it } from "vitest";

import { redactScreen } from "./redaction.js";

describe("redactScreen", () => {
  it("redacts AWS access key", () => {
    const out = redactScreen("export AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts GitHub PAT", () => {
    const out = redactScreen("token: ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(out).not.toContain("ghp_");
  });

  it("redacts Anthropic API key", () => {
    const out = redactScreen("ANTHROPIC=sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx");
    expect(out).not.toContain("sk-ant-api03");
  });

  it("redacts Bearer header", () => {
    const out = redactScreen("Authorization: Bearer abc.def.ghi");
    expect(out).not.toContain("abc.def.ghi");
  });

  it("redacts JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart";
    const out = redactScreen(`token=${jwt}`);
    expect(out).not.toContain(jwt);
  });

  it("leaves non-secret text untouched", () => {
    const plain = "hello world\n>>> 1 + 1\n2\n";
    expect(redactScreen(plain)).toBe(plain);
  });
});
