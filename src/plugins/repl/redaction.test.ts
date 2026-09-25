import { describe, expect, it } from "vitest";

import { redactCommandLine, redactScreen } from "./redaction.js";

const FINE_GRAINED_GITHUB_TOKEN =
  "github_pat_11AAAAAA00000000000000_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const OPENAI_PROJECT_TOKEN =
  "sk-proj-1234567890-abcdefghijklmnop-qrstuvwxyz";

describe("redactScreen", () => {
  it("redacts AWS access key", () => {
    const out = redactScreen("export AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED]");
  });

  it.each([
    ["ABIA access key", "ABIAIOSFODNN7EXAMPLE"],
    ["A3T access key", "A3TBIOSFODNN7EXAMPLE"],
  ])("redacts the %s AWS family", (_label, key) => {
    const out = redactScreen(`export AWS_ACCESS_KEY=${key}`);
    expect(out).not.toContain(key);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts GitHub PAT", () => {
    const out = redactScreen("token: ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(out).not.toContain("ghp_");
  });

  it.each([
    ["GitHub fine-grained PAT", FINE_GRAINED_GITHUB_TOKEN],
    ["OpenAI project key", OPENAI_PROJECT_TOKEN],
  ])("redacts a full %s", (_label, token) => {
    const out = redactScreen(`token=${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts new token families when prefixes and bodies cross raw controls", () => {
    const githubPrefixEnd = FINE_GRAINED_GITHUB_TOKEN.indexOf("_", "github_pat".length) + 1;
    const githubBodySplit = githubPrefixEnd + 18;
    const openaiPrefixEnd = OPENAI_PROJECT_TOKEN.indexOf("-", "sk-".length) + 1;
    const openaiBodySplit = openaiPrefixEnd + 16;
    const raw =
      `grid ${FINE_GRAINED_GITHUB_TOKEN.slice(0, githubPrefixEnd)}\u001b[0m` +
      `${FINE_GRAINED_GITHUB_TOKEN.slice(githubPrefixEnd, githubBodySplit)}\u001b]0;split\u0007` +
      `${FINE_GRAINED_GITHUB_TOKEN.slice(githubBodySplit)} ` +
      `raw ${OPENAI_PROJECT_TOKEN.slice(0, openaiPrefixEnd)}\u001b[0m` +
      `${OPENAI_PROJECT_TOKEN.slice(openaiPrefixEnd, openaiBodySplit)}\u001b]0;split\u0007` +
      OPENAI_PROJECT_TOKEN.slice(openaiBodySplit);

    const out = redactScreen(raw);

    expect(out).not.toContain(FINE_GRAINED_GITHUB_TOKEN);
    expect(out).not.toContain(OPENAI_PROJECT_TOKEN);
    expect(out).toContain("[REDACTED]");
  });
  it("redacts tokens split by ANSI and OSC controls", () => {
    const aws = "ASIAIOSFODNN7EXAMPLE";
    const github = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const raw =
      `before \u001b[31m${aws.slice(0, 4)}\u001b[0m${aws.slice(4)}\u001b[39m ` +
      `\u001b]0;title\u0007${github.slice(0, 8)}\u001b]0;separator\u0007${github.slice(8)}\u001b]0;end\u0007 after`;

    const out = redactScreen(raw);

    expect(out).not.toContain(aws);
    expect(out).not.toContain(github);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("\u001b[31m");
    expect(out).toContain("\u001b[39m");
    expect(out).toContain("\u001b]0;title\u0007");
    expect(out).toContain("\u001b]0;end\u0007");
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

  it.each([
    ["PASSWORD=short-secret", "PASSWORD=[REDACTED]"],
    ["API_KEY=abc123", "API_KEY=[REDACTED]"],
    ["Password: hunter2", "Password: [REDACTED]"],
    ["PASSWORD=\"short secret\"", "PASSWORD=\"[REDACTED]\""],
  ])("redacts generic sensitive assignment %s", (input, expected) => {
    expect(redactScreen(input)).toBe(expected);
  });

  it("redacts a value echoed on the line after a password prompt", () => {
    const out = redactScreen("Password:\nhunter2\n");
    expect(out).toBe("Password:\n[REDACTED]\n");
    expect(out).not.toContain("hunter2");
  });

  it("redacts complete password prompt values, including spaces and blank lines", () => {
    const out = redactScreen(
      "Enter password: hunter two\n\nPassword:\n\nhunter two\n",
    );

    expect(out).toBe(
      "Enter password: [REDACTED]\n\nPassword:\n\n[REDACTED]\n",
    );
    expect(out).not.toContain("hunter two");
  });

  it("redacts generic assignments split by terminal controls", () => {
    const out = redactScreen(
      "\u001b[31mPASSWORD\u001b[0m=short-secret\u001b[39m",
    );

    expect(out).not.toContain("short-secret");
    expect(out).toContain("PASSWORD");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("\u001b[31m");
    expect(out).toContain("\u001b[39m");
  });

  it("leaves non-secret text untouched", () => {
    const plain = "hello world\n>>> 1 + 1\n2\n";
    expect(redactScreen(plain)).toBe(plain);
  });
});

describe("redactCommandLine", () => {
  it("redacts assignments and flag values without dropping safe arguments", () => {
    const command =
      "PASSWORD=pass-secret TOKEN=token-secret deploy --api-key api-secret --region us-east-1";

    expect(redactCommandLine(command)).toBe(
      "PASSWORD=[REDACTED] TOKEN=[REDACTED] deploy --api-key [REDACTED] --region us-east-1",
    );
  });

  it.each([
    ["mysql -psecret --host db.example", "mysql -p[REDACTED] --host db.example"],
    ["mysql -p secret --host db.example", "mysql -p [REDACTED] --host db.example"],
  ])("redacts MySQL password form %s", (command, expected) => {
    expect(redactCommandLine(command)).toBe(expected);
  });

  it("does not consume an option after a bare MySQL password flag", () => {
    const command = "mysql -p --host db.example --database app";
    expect(redactCommandLine(command)).toBe(command);
  });

  it("keeps generic credential-shaped values redacted with their safe arguments", () => {
    const command = "deploy --key sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA --region us-east-1";
    expect(redactCommandLine(command)).toBe(
      "deploy --key [REDACTED] --region us-east-1",
    );
  });
  it("redacts fine-grained GitHub and hyphenated OpenAI project keys in commands", () => {
    const command =
      `deploy --model ${OPENAI_PROJECT_TOKEN} --label ${FINE_GRAINED_GITHUB_TOKEN} --region us-east-1`;

    const out = redactCommandLine(command);

    expect(out).not.toContain(FINE_GRAINED_GITHUB_TOKEN);
    expect(out).not.toContain(OPENAI_PROJECT_TOKEN);
    expect(out).toContain("deploy --model [REDACTED] --label [REDACTED] --region us-east-1");
  });
});
