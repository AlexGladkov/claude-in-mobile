import { unlink } from "fs/promises";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { z } from "zod";
import { validateBaselineName, validatePathContainment } from "./sanitize.js";
import { readJsonOrDefault, writeJsonAtomic } from "./json-file.js";
import { ensurePrivateDirectory } from "./private-storage.js";
import {
  ScenarioNotFoundError,
  ScenarioExistsError,
  ScenarioCorruptedError,
  ValidationError,
} from "../errors.js";

// ── Types ──

export interface ScenarioStep {
  index: number;
  type: "tool_call" | "wait" | "assert" | "visual" | "navigate" | "data_input" | "gesture";
  action: string;
  args: Record<string, unknown>;
  label?: string;
  timestampMs: number;
  delayBeforeMs: number;
  sensitive?: boolean;
  assertion?: {
    type: "element_exists" | "element_not_exists" | "visual_match" | "text_contains";
    target: string;
    options?: Record<string, unknown>;
  };
  onError?: "stop" | "skip" | "retry";
}

export interface Scenario {
  version: 1;
  name: string;
  platform: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  checksum: string;
  steps: ScenarioStep[];
  metadata: {
    recordedWithVersion: string;
    totalRecordingTimeMs: number;
    deviceInfo?: string;
  };
}

export interface ScenarioEntry {
  name: string;
  platform: string;
  tags: string[];
  description: string;
  stepCount: number;
  fileSize: number;
  checksum: string;
  createdAt: string;
  updatedAt: string;
}

interface Manifest {
  version: 1;
  scenarios: ScenarioEntry[];
}

// ── Constants ──

const DEFAULT_DIR = ".test-scenarios";
const MANIFEST_FILE = "manifest.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_SCENARIOS = 200;
const MAX_SCENARIO_FILE_SIZE = 512 * 1024; // 512KB
const MAX_TOTAL_SIZE = 50 * 1024 * 1024;   // 50MB
export const MAX_STEPS_PER_SCENARIO = 100;
const FORBIDDEN_KEY_LOOKUP: Readonly<Record<string, true>> = Object.freeze({
  ["__proto__"]: true as const,
  constructor: true as const,
  prototype: true as const,
});
const MAX_MANIFEST_FILE_SIZE = 1024 * 1024;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_DEPTH = 16;
const scenarioObjectKeySchema = z.string().max(256).refine(
  (key) => !Object.hasOwn(FORBIDDEN_KEY_LOOKUP, key),
  "Step args contain a forbidden key",
);

const scenarioJsonValueSchema = z.unknown().superRefine((root, ctx) => {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Step args exceed the value limit" });
      return;
    }
    if (
      current.value === null
      || typeof current.value === "boolean"
      || (typeof current.value === "number" && Number.isFinite(current.value))
      || (typeof current.value === "string" && current.value.length <= 65_536)
    ) {
      continue;
    }
    if (current.depth >= MAX_JSON_DEPTH) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Step args exceed the nesting limit" });
      return;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > 1_000) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Step args array is too large" });
        return;
      }
      for (const value of current.value) stack.push({ value, depth: current.depth + 1 });
      continue;
    }
    if (typeof current.value === "object") {
      const entries = Object.entries(current.value);
      if (entries.length > 1_000) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Step args object is too large" });
        return;
      }
      for (const [key, value] of entries) {
        if (Object.hasOwn(FORBIDDEN_KEY_LOOKUP, key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Step args contain forbidden key: ${key}`,
          });
          return;
        }
        stack.push({ value, depth: current.depth + 1 });
      }
      continue;
    }
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Step args must contain JSON values" });
    return;
  }
});

const scenarioAssertionSchema = z.object({
  type: z.enum(["element_exists", "element_not_exists", "visual_match", "text_contains"]),
  target: z.string().min(1).max(4_096),
  options: z.record(scenarioObjectKeySchema, scenarioJsonValueSchema).optional(),
}).strict();

const scenarioStepSchema = z.object({
  index: z.number().int().nonnegative().max(MAX_STEPS_PER_SCENARIO),
  type: z.enum(["tool_call", "wait", "assert", "visual", "navigate", "data_input", "gesture"]),
  action: z.string().min(1).max(256),
  args: z.record(scenarioObjectKeySchema, scenarioJsonValueSchema),
  label: z.string().max(4_096).optional(),
  timestampMs: z.number().finite().nonnegative(),
  delayBeforeMs: z.number().finite().nonnegative(),
  sensitive: z.boolean().optional(),
  assertion: scenarioAssertionSchema.optional(),
  onError: z.enum(["stop", "skip", "retry"]).optional(),
}).strict();

const scenarioSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(128),
  platform: z.string().min(1).max(128),
  description: z.string().max(16_384),
  tags: z.array(z.string().max(256)).max(64),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  steps: z.array(scenarioStepSchema).max(MAX_STEPS_PER_SCENARIO),
  metadata: z.object({
    recordedWithVersion: z.string().min(1).max(128),
    totalRecordingTimeMs: z.number().finite().nonnegative(),
    deviceInfo: z.string().max(4_096).optional(),
  }).strict(),
}).strict();

const scenarioEntrySchema = z.object({
  name: z.string().min(1).max(128),
  platform: z.string().min(1).max(128),
  tags: z.array(z.string().max(256)).max(64),
  description: z.string().max(16_384),
  stepCount: z.number().int().nonnegative().max(MAX_STEPS_PER_SCENARIO),
  fileSize: z.number().int().nonnegative().max(MAX_SCENARIO_FILE_SIZE),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const scenarioManifestSchema = z.object({
  version: z.literal(1),
  scenarios: z.array(scenarioEntrySchema).max(MAX_SCENARIOS),
}).strict();

// ── ScenarioStore ──

export class ScenarioStore {
  private readonly scenariosDir: string;

  constructor(cwd?: string) {
    const envDir = process.env.CLAUDE_MOBILE_SCENARIOS_DIR;
    if (envDir) {
      this.scenariosDir = resolve(envDir);
    } else {
      this.scenariosDir = join(cwd ?? process.cwd(), DEFAULT_DIR);
    }
  }

  // ── Private ──

  private getScenarioPath(platform: string, name: string): string {
    const filePath = join(this.scenariosDir, platform, `${name}.json`);
    validatePathContainment(filePath, this.scenariosDir);
    return filePath;
  }

  private get manifestPath(): string {
    return join(this.scenariosDir, MANIFEST_FILE);
  }

  private async readManifest(): Promise<Manifest> {
    await ensurePrivateDirectory(this.scenariosDir);
    const manifest = await readJsonOrDefault(
      this.manifestPath,
      (): Manifest => ({ version: 1, scenarios: [] }),
      "scenario manifest",
      MAX_MANIFEST_FILE_SIZE,
    );
    const result = scenarioManifestSchema.safeParse(manifest);
    if (!result.success) {
      throw new ValidationError("Scenario manifest is corrupted or has an unsupported version");
    }
    return result.data;
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    await this.ensureDir();
    await writeJsonAtomic(this.manifestPath, manifest, FILE_MODE);
  }

  private async ensureDir(platform?: string): Promise<void> {
    await ensurePrivateDirectory(this.scenariosDir);
    if (platform) {
      const dir = join(this.scenariosDir, platform);
      validatePathContainment(dir, this.scenariosDir);
      await ensurePrivateDirectory(dir);
    }
  }

  private computeChecksum(steps: ScenarioStep[]): string {
    return createHash("sha256").update(JSON.stringify(steps)).digest("hex");
  }

  private findEntry(manifest: Manifest, name: string, platform: string): ScenarioEntry | undefined {
    return manifest.scenarios.find(e => e.name === name && e.platform === platform);
  }

  private getTotalSize(manifest: Manifest): number {
    return manifest.scenarios.reduce((sum, e) => sum + e.fileSize, 0);
  }

  private validateScenarioJson(data: unknown): Scenario {
    const result = scenarioSchema.safeParse(data);
    if (!result.success) {
      throw new ValidationError("Scenario file is invalid or has an unsupported version");
    }
    return result.data;
  }

  // ── Public API ──

  async save(scenario: Scenario, options?: { overwrite?: boolean }): Promise<ScenarioEntry> {
    this.validateScenarioJson(scenario);
    validateBaselineName(scenario.name, "scenario_name");
    validateBaselineName(scenario.platform, "platform");

    if (scenario.steps.length > MAX_STEPS_PER_SCENARIO) {
      throw new ValidationError(`Scenario exceeds ${MAX_STEPS_PER_SCENARIO} steps limit (has ${scenario.steps.length})`);
    }

    const manifest = await this.readManifest();
    const existing = this.findEntry(manifest, scenario.name, scenario.platform);

    if (existing && !options?.overwrite) {
      throw new ScenarioExistsError(scenario.name, scenario.platform);
    }

    if (!existing && manifest.scenarios.length >= MAX_SCENARIOS) {
      throw new ValidationError(`Scenario limit reached: ${MAX_SCENARIOS}. Delete unused scenarios first.`);
    }

    const checksum = this.computeChecksum(scenario.steps);
    const normalizedScenario: Scenario = { ...scenario, checksum };
    const jsonData = JSON.stringify(normalizedScenario, null, 2);
    const fileSize = Buffer.byteLength(jsonData);

    if (fileSize > MAX_SCENARIO_FILE_SIZE) {
      throw new ValidationError(`Scenario file too large: ${(fileSize / 1024).toFixed(0)}KB (max ${MAX_SCENARIO_FILE_SIZE / 1024}KB)`);
    }

    const totalSize = this.getTotalSize(manifest) - (existing?.fileSize ?? 0) + fileSize;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new ValidationError(`Total scenario storage exceeded: ${(totalSize / 1024 / 1024).toFixed(0)}MB (max ${MAX_TOTAL_SIZE / 1024 / 1024}MB)`);
    }

    await this.ensureDir(scenario.platform);
    const filePath = this.getScenarioPath(scenario.platform, scenario.name);
    await writeJsonAtomic(filePath, normalizedScenario, FILE_MODE);
    const now = new Date().toISOString();
    const entry: ScenarioEntry = {
      name: scenario.name,
      platform: scenario.platform,
      tags: scenario.tags ?? [],
      description: scenario.description ?? "",
      stepCount: scenario.steps.length,
      fileSize,
      checksum,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (existing) {
      const idx = manifest.scenarios.indexOf(existing);
      manifest.scenarios[idx] = entry;
    } else {
      manifest.scenarios.push(entry);
    }

    await this.writeManifest(manifest);
    return entry;
  }

  async get(name: string, platform: string): Promise<Scenario> {
    validateBaselineName(platform, "platform");
    validateBaselineName(name, "scenario_name");
    const manifest = await this.readManifest();
    const entry = this.findEntry(manifest, name, platform);
    if (!entry) throw new ScenarioNotFoundError(name, platform);

    const filePath = this.getScenarioPath(platform, name);
    let parsed: unknown;
    try {
      parsed = await readJsonOrDefault(
        filePath,
        () => {
          throw new ScenarioNotFoundError(name, platform);
        },
        `scenario "${name}"`,
        MAX_SCENARIO_FILE_SIZE,
      );
    } catch (error) {
      if (error instanceof ScenarioNotFoundError) throw error;
      throw new ScenarioCorruptedError(name, "invalid, oversized, or unreadable JSON");
    }
    const scenario = this.validateScenarioJson(parsed);

    // Verify checksum
    const actualChecksum = this.computeChecksum(scenario.steps);
    if (actualChecksum !== entry.checksum) {
      throw new ScenarioCorruptedError(name, "checksum mismatch — file was modified externally");
    }

    return scenario;
  }

  async delete(name: string, platform: string): Promise<void> {
    validateBaselineName(platform, "platform");
    validateBaselineName(name, "scenario_name");
    const manifest = await this.readManifest();
    const entry = this.findEntry(manifest, name, platform);
    if (!entry) throw new ScenarioNotFoundError(name, platform);

    const filePath = this.getScenarioPath(platform, name);
    try {
      await unlink(filePath);
    } catch {
      // File already gone — ok
    }

    manifest.scenarios = manifest.scenarios.filter(e => !(e.name === name && e.platform === platform));
    await this.writeManifest(manifest);
  }

  async list(platform?: string, tag?: string): Promise<ScenarioEntry[]> {
    const manifest = await this.readManifest();
    let entries = manifest.scenarios;
    if (platform) entries = entries.filter(e => e.platform === platform);
    if (tag) entries = entries.filter(e => e.tags.includes(tag));
    return entries;
  }

  getScenariosDir(): string {
    return this.scenariosDir;
  }
}
