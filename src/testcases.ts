import * as fs from "fs";
import * as path from "path";
import yaml from "js-yaml";

// ============ Types ============

export interface TestCaseStep {
  action: string;
  expected: string;
}

export interface TestCaseMeta {
  id: string;
  name: string;
  platform: string;
  priority: string;
  tags: string[];
  author: string;
  created_at: string;
  linked_feature?: string;
  last_run_status?: string;
  description: string;
  preconditions?: string[];
  steps: TestCaseStep[];
}

// ============ Parsing & Validation ============

/**
 * Parse YAML content into a TestCaseMeta object.
 * Throws if YAML is malformed or required fields are missing.
 */
export function parseTestCase(yamlContent: string): TestCaseMeta {
  let parsed: unknown;
  try {
    parsed = yaml.load(yamlContent);
  } catch (e: any) {
    throw new Error(`Malformed YAML: ${e.message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("YAML must be a mapping (object), got: " + typeof parsed);
  }

  const obj = parsed as Record<string, unknown>;

  const requiredFields = ["id", "name", "platform", "priority", "tags", "author", "created_at", "description", "steps"];
  for (const field of requiredFields) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  if (!Array.isArray(obj.tags)) {
    throw new Error("Field 'tags' must be an array");
  }

  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new Error("Field 'steps' must be a non-empty array");
  }

  for (let i = 0; i < (obj.steps as unknown[]).length; i++) {
    const step = (obj.steps as unknown[])[i];
    if (!step || typeof step !== "object") {
      throw new Error(`Step ${i + 1} must be an object`);
    }
    const s = step as Record<string, unknown>;
    if (!s.action || typeof s.action !== "string") {
      throw new Error(`Step ${i + 1} missing 'action' field`);
    }
    if (!s.expected || typeof s.expected !== "string") {
      throw new Error(`Step ${i + 1} missing 'expected' field`);
    }
  }

  return {
    id: String(obj.id),
    name: String(obj.name),
    platform: String(obj.platform),
    priority: String(obj.priority),
    tags: (obj.tags as unknown[]).map(String),
    author: String(obj.author),
    created_at: String(obj.created_at),
    linked_feature: obj.linked_feature != null ? String(obj.linked_feature) : undefined,
    last_run_status: obj.last_run_status != null ? String(obj.last_run_status) : undefined,
    description: String(obj.description),
    preconditions: obj.preconditions != null && Array.isArray(obj.preconditions)
      ? (obj.preconditions as unknown[]).map(String)
      : undefined,
    steps: (obj.steps as Array<Record<string, unknown>>).map((s) => ({
      action: String(s.action),
      expected: String(s.expected),
    })),
  };
}

/**
 * Validate a parsed TestCaseMeta object.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateTestCase(tc: TestCaseMeta): string | null {
  if (!tc.id.trim()) return "id must not be empty";
  if (!tc.name.trim()) return "name must not be empty";
  if (!tc.platform.trim()) return "platform must not be empty";
  if (!tc.description.trim()) return "description must not be empty";

  const validPriorities = ["critical", "high", "medium", "low"];
  if (!validPriorities.includes(tc.priority.toLowerCase())) {
    return `priority must be one of: ${validPriorities.join(", ")}`;
  }

  if (tc.steps.length === 0) return "steps must not be empty";

  for (let i = 0; i < tc.steps.length; i++) {
    if (!tc.steps[i].action.trim()) return `Step ${i + 1}: action must not be empty`;
    if (!tc.steps[i].expected.trim()) return `Step ${i + 1}: expected must not be empty`;
  }

  return null;
}

// ============ File Operations ============

/**
 * Scan a directory for YAML test case files, parse their metadata.
 * Optionally filter by platform.
 */
export function listTestCases(dirPath: string, platformFilter?: string): TestCaseMeta[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const files = fs.readdirSync(dirPath).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml")
  );

  const results: TestCaseMeta[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dirPath, file), "utf-8");
      const tc = parseTestCase(content);
      if (platformFilter && tc.platform.toLowerCase() !== platformFilter.toLowerCase()) {
        continue;
      }
      results.push(tc);
    } catch {
      // Skip files that fail to parse
    }
  }

  return results;
}

/**
 * Validate YAML content and write to file. Returns full path.
 */
export function saveTestCase(dirPath: string, filename: string, content: string): string {
  const tc = parseTestCase(content);
  const validationError = validateTestCase(tc);
  if (validationError) {
    throw new Error(`Validation failed: ${validationError}`);
  }

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const safeName = filename.endsWith(".yaml") || filename.endsWith(".yml")
    ? filename
    : filename + ".yaml";

  const fullPath = path.join(dirPath, safeName);
  fs.writeFileSync(fullPath, content, "utf-8");
  return fullPath;
}

/**
 * Read a test case file and return raw content + parsed metadata.
 */
export function readTestCase(filePath: string): { content: string; parsed: TestCaseMeta } {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = parseTestCase(content);
  return { content, parsed };
}

/**
 * Delete a test case file.
 */
export function deleteTestCase(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  fs.unlinkSync(filePath);
}
