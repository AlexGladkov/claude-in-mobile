import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  parseTestCase,
  validateTestCase,
  listTestCases,
  saveTestCase,
  readTestCase,
  deleteTestCase,
} from "./testcases.js";

const VALID_YAML = `
id: TC001
name: Login with valid credentials
platform: android
priority: high
tags: [auth, smoke]
author: claude
created_at: "2026-01-01"
description: Verify login with valid email and password
steps:
  - action: Enter email into the email field
    expected: Email field shows text
  - action: Tap Login button
    expected: User sees home screen
`.trim();

const VALID_YAML_IOS = `
id: TC002
name: iOS settings check
platform: ios
priority: medium
tags: [settings]
author: claude
created_at: "2026-01-02"
description: Verify settings page loads on iOS
steps:
  - action: Open Settings app
    expected: Settings screen is displayed
`.trim();

describe("parseTestCase", () => {
  it("parses valid YAML correctly", () => {
    const tc = parseTestCase(VALID_YAML);
    expect(tc.id).toBe("TC001");
    expect(tc.name).toBe("Login with valid credentials");
    expect(tc.platform).toBe("android");
    expect(tc.priority).toBe("high");
    expect(tc.tags).toEqual(["auth", "smoke"]);
    expect(tc.author).toBe("claude");
    expect(tc.description).toBe("Verify login with valid email and password");
    expect(tc.steps).toHaveLength(2);
    expect(tc.steps[0].action).toBe("Enter email into the email field");
    expect(tc.steps[0].expected).toBe("Email field shows text");
  });

  it("throws on missing required fields", () => {
    const noId = VALID_YAML.replace("id: TC001\n", "");
    expect(() => parseTestCase(noId)).toThrow("Missing required field: id");
  });

  it("throws on missing steps", () => {
    const noSteps = `
id: TC001
name: Test
platform: android
priority: high
tags: [test]
author: claude
created_at: "2026-01-01"
description: A test
`.trim();
    expect(() => parseTestCase(noSteps)).toThrow("Missing required field: steps");
  });

  it("throws on empty steps array", () => {
    const emptySteps = `
id: TC001
name: Test
platform: android
priority: high
tags: [test]
author: claude
created_at: "2026-01-01"
description: A test
steps: []
`.trim();
    expect(() => parseTestCase(emptySteps)).toThrow("non-empty array");
  });

  it("throws on malformed YAML", () => {
    expect(() => parseTestCase("{{invalid: yaml: [}")).toThrow("Malformed YAML");
  });

  it("throws on step missing action", () => {
    const badStep = `
id: TC001
name: Test
platform: android
priority: high
tags: [test]
author: claude
created_at: "2026-01-01"
description: A test
steps:
  - expected: Something happens
`.trim();
    expect(() => parseTestCase(badStep)).toThrow("missing 'action'");
  });

  it("throws on step missing expected", () => {
    const badStep = `
id: TC001
name: Test
platform: android
priority: high
tags: [test]
author: claude
created_at: "2026-01-01"
description: A test
steps:
  - action: Do something
`.trim();
    expect(() => parseTestCase(badStep)).toThrow("missing 'expected'");
  });

  it("handles optional fields", () => {
    const withOptional = VALID_YAML + `\nlinked_feature: FL001\npreconditions:\n  - App installed`;
    const tc = parseTestCase(withOptional);
    expect(tc.linked_feature).toBe("FL001");
    expect(tc.preconditions).toEqual(["App installed"]);
  });
});

describe("validateTestCase", () => {
  it("returns null for valid test case", () => {
    const tc = parseTestCase(VALID_YAML);
    expect(validateTestCase(tc)).toBeNull();
  });

  it("rejects invalid priority", () => {
    const tc = parseTestCase(VALID_YAML);
    tc.priority = "urgent";
    expect(validateTestCase(tc)).toContain("priority must be one of");
  });

  it("rejects empty id", () => {
    const tc = parseTestCase(VALID_YAML);
    tc.id = "  ";
    expect(validateTestCase(tc)).toBe("id must not be empty");
  });

  it("rejects empty step action", () => {
    const tc = parseTestCase(VALID_YAML);
    tc.steps[0].action = "  ";
    expect(validateTestCase(tc)).toContain("action must not be empty");
  });
});

describe("file operations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "testcases-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveTestCase writes and returns path", () => {
    const result = saveTestCase(tmpDir, "TC001-login.yaml", VALID_YAML);
    expect(result).toBe(path.join(tmpDir, "TC001-login.yaml"));
    expect(fs.existsSync(result)).toBe(true);
  });

  it("saveTestCase appends .yaml if missing", () => {
    const result = saveTestCase(tmpDir, "TC001-login", VALID_YAML);
    expect(result.endsWith(".yaml")).toBe(true);
  });

  it("saveTestCase creates directory if needed", () => {
    const nested = path.join(tmpDir, "sub", "dir");
    const result = saveTestCase(nested, "TC001.yaml", VALID_YAML);
    expect(fs.existsSync(result)).toBe(true);
  });

  it("saveTestCase rejects invalid YAML", () => {
    expect(() => saveTestCase(tmpDir, "bad.yaml", "not: valid: yaml: [}")).toThrow();
  });

  it("readTestCase returns content and parsed", () => {
    const filePath = saveTestCase(tmpDir, "TC001.yaml", VALID_YAML);
    const { content, parsed } = readTestCase(filePath);
    expect(content).toBe(VALID_YAML);
    expect(parsed.id).toBe("TC001");
  });

  it("readTestCase throws on missing file", () => {
    expect(() => readTestCase(path.join(tmpDir, "nope.yaml"))).toThrow("File not found");
  });

  it("deleteTestCase removes the file", () => {
    const filePath = saveTestCase(tmpDir, "TC001.yaml", VALID_YAML);
    expect(fs.existsSync(filePath)).toBe(true);
    deleteTestCase(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("deleteTestCase throws on missing file", () => {
    expect(() => deleteTestCase(path.join(tmpDir, "nope.yaml"))).toThrow("File not found");
  });

  it("listTestCases returns all cases", () => {
    saveTestCase(tmpDir, "TC001.yaml", VALID_YAML);
    saveTestCase(tmpDir, "TC002.yaml", VALID_YAML_IOS);
    const cases = listTestCases(tmpDir);
    expect(cases).toHaveLength(2);
  });

  it("listTestCases filters by platform", () => {
    saveTestCase(tmpDir, "TC001.yaml", VALID_YAML);
    saveTestCase(tmpDir, "TC002.yaml", VALID_YAML_IOS);
    const android = listTestCases(tmpDir, "android");
    expect(android).toHaveLength(1);
    expect(android[0].id).toBe("TC001");

    const ios = listTestCases(tmpDir, "ios");
    expect(ios).toHaveLength(1);
    expect(ios[0].id).toBe("TC002");
  });

  it("listTestCases returns empty for non-existent dir", () => {
    const cases = listTestCases(path.join(tmpDir, "nope"));
    expect(cases).toEqual([]);
  });

  it("listTestCases skips invalid files", () => {
    saveTestCase(tmpDir, "TC001.yaml", VALID_YAML);
    fs.writeFileSync(path.join(tmpDir, "bad.yaml"), "not valid yaml: [}", "utf-8");
    const cases = listTestCases(tmpDir);
    expect(cases).toHaveLength(1);
  });
});
