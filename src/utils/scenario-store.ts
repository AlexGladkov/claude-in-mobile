import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { validateBaselineName, validatePathContainment } from "./sanitize.js";
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

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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
    try {
      const data = await readFile(this.manifestPath, "utf-8");
      return JSON.parse(data) as Manifest;
    } catch {
      return { version: 1, scenarios: [] };
    }
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    await this.ensureDir();
    const data = JSON.stringify(manifest, null, 2);
    await writeFile(this.manifestPath, data, { mode: FILE_MODE });
  }

  private async ensureDir(platform?: string): Promise<void> {
    const dir = platform ? join(this.scenariosDir, platform) : this.scenariosDir;
    validatePathContainment(dir, this.scenariosDir);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
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
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new ValidationError("Scenario file must be a JSON object");
    }
    const obj = data as Record<string, unknown>;

    // Prototype pollution defense
    for (const key of Object.keys(obj)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new ValidationError(`Scenario file contains forbidden key: ${key}`);
      }
    }

    if (obj.version !== 1) {
      throw new ValidationError("Unsupported scenario version");
    }
    if (typeof obj.name !== "string" || !obj.name) {
      throw new ValidationError("Scenario must have a non-empty name");
    }
    if (!Array.isArray(obj.steps)) {
      throw new ValidationError("Scenario must contain a steps array");
    }
    if (obj.steps.length > MAX_STEPS_PER_SCENARIO) {
      throw new ValidationError(`Scenario exceeds ${MAX_STEPS_PER_SCENARIO} steps limit`);
    }

    // Validate each step
    for (const step of obj.steps) {
      if (typeof step !== "object" || step === null) {
        throw new ValidationError("Each step must be an object");
      }
      const s = step as Record<string, unknown>;
      if (typeof s.action !== "string" || !s.action) {
        throw new ValidationError("Each step must have a non-empty string action");
      }
      if (s.args !== undefined && (typeof s.args !== "object" || s.args === null || Array.isArray(s.args))) {
        throw new ValidationError("Step args must be a plain object");
      }
      if (s.args) {
        for (const key of Object.keys(s.args as Record<string, unknown>)) {
          if (FORBIDDEN_KEYS.has(key)) {
            throw new ValidationError(`Step args contain forbidden key: ${key}`);
          }
        }
      }
    }

    return data as Scenario;
  }

  // ── Public API ──

  async save(scenario: Scenario, options?: { overwrite?: boolean }): Promise<ScenarioEntry> {
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

    const jsonData = JSON.stringify(scenario, null, 2);
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
    await writeFile(filePath, jsonData, { mode: FILE_MODE });

    const now = new Date().toISOString();
    const entry: ScenarioEntry = {
      name: scenario.name,
      platform: scenario.platform,
      tags: scenario.tags ?? [],
      description: scenario.description ?? "",
      stepCount: scenario.steps.length,
      fileSize,
      checksum: scenario.checksum,
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
    validateBaselineName(name, "scenario_name");
    const manifest = await this.readManifest();
    const entry = this.findEntry(manifest, name, platform);
    if (!entry) throw new ScenarioNotFoundError(name, platform);

    const filePath = this.getScenarioPath(platform, name);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      throw new ScenarioNotFoundError(name, platform);
    }

    if (Buffer.byteLength(raw) > MAX_SCENARIO_FILE_SIZE) {
      throw new ValidationError(`Scenario file exceeds ${MAX_SCENARIO_FILE_SIZE / 1024}KB limit`);
    }

    const parsed = JSON.parse(raw);
    const scenario = this.validateScenarioJson(parsed);

    // Verify checksum
    const actualChecksum = this.computeChecksum(scenario.steps);
    if (actualChecksum !== entry.checksum) {
      throw new ScenarioCorruptedError(name, "checksum mismatch — file was modified externally");
    }

    return scenario;
  }

  async delete(name: string, platform: string): Promise<void> {
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
