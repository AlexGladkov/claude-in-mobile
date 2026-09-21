/**
 * File persistence for exploration data and generated tests.
 * Stores JSON files in `.test-explorations/` directory.
 */

import { lstat, mkdir, opendir } from "fs/promises";
import { join, resolve } from "path";
import { z } from "zod";
import { validatePathContainment } from "./sanitize.js";
import { MobileError } from "../errors.js";
import { readJsonOrDefault, writeJsonAtomic } from "./json-file.js";
import type { ExplorationResult, GeneratedTestSuite } from "../autopilot/types.js";

// ── Constants ──

const DEFAULT_DIR = ".test-explorations";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_EXPLORATIONS = 100;
const MAX_STORE_ENTRIES = 1000;

// ── Helpers ──

/**
 * Sanitize an exploration ID to prevent path traversal.
 * Only alphanumeric, hyphens, underscores, and dots allowed.
 */
function sanitizeId(id: string): string {
  if (
    id.length === 0
    || id.length > 128
    || id === "."
    || id === ".."
    || !/^[a-zA-Z0-9._-]+$/.test(id)
  ) {
    throw new MobileError("Invalid exploration identifier.", "INVALID_EXPLORATION_ID");
  }
  return id;
}

const boundedTextSchema = z.string().max(4096);
const finiteNumberSchema = z.number().finite();
const uiBoundsSchema = z.object({
  x1: finiteNumberSchema,
  y1: finiteNumberSchema,
  x2: finiteNumberSchema,
  y2: finiteNumberSchema,
}).strict();
const uiElementSchema = z.object({
  index: z.number().int().nonnegative(),
  resourceId: boundedTextSchema,
  className: boundedTextSchema,
  packageName: boundedTextSchema,
  text: boundedTextSchema,
  contentDesc: boundedTextSchema,
  checkable: z.boolean(),
  checked: z.boolean(),
  clickable: z.boolean(),
  enabled: z.boolean(),
  focusable: z.boolean(),
  focused: z.boolean(),
  scrollable: z.boolean(),
  longClickable: z.boolean(),
  password: z.boolean(),
  selected: z.boolean(),
  bounds: uiBoundsSchema,
  centerX: finiteNumberSchema,
  centerY: finiteNumberSchema,
  width: finiteNumberSchema.nonnegative(),
  height: finiteNumberSchema.nonnegative(),
}).strict();
const explorationActionSchema = z.object({
  type: z.enum(["tap", "long_press", "swipe", "key"]),
  elementIndex: z.number().int().nonnegative().optional(),
  elementText: boundedTextSchema.optional(),
  elementResourceId: boundedTextSchema.optional(),
  elementClassName: boundedTextSchema.optional(),
  x: finiteNumberSchema.optional(),
  y: finiteNumberSchema.optional(),
  key: boundedTextSchema.optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
}).strict();
const screenNodeSchema = z.object({
  id: z.string().min(1).max(128),
  fingerprint: z.string().min(1).max(4096),
  elements: z.array(uiElementSchema).max(10_000),
  screenshotBase64: z.string().max(12 * 1024 * 1024).optional(),
  activity: boundedTextSchema.optional(),
  title: boundedTextSchema.optional(),
  visitedAt: z.string().min(1).max(128),
}).strict();
const navigationEdgeSchema = z.object({
  fromScreenId: z.string().min(1).max(128),
  toScreenId: z.string().min(1).max(128),
  action: explorationActionSchema,
  timestamp: z.string().min(1).max(128),
}).strict();
const explorationResultSchema = z.object({
  id: z.string().min(1).max(128),
  package: z.string().min(1).max(255),
  strategy: z.enum(["bfs", "dfs", "smart"]),
  startedAt: z.string().min(1).max(128),
  completedAt: z.string().min(1).max(128),
  graph: z.object({
    screens: z.array(screenNodeSchema).max(1000),
    edges: z.array(navigationEdgeSchema).max(10_000),
  }).strict(),
  stats: z.object({
    screensFound: z.number().int().nonnegative(),
    edgesFound: z.number().int().nonnegative(),
    actionsPerformed: z.number().int().nonnegative(),
    maxScreensReached: z.boolean(),
    maxActionsReached: z.boolean(),
    dryRun: z.boolean(),
  }).strict(),
}).strict();
const generatedStepArgsSchema = z.record(
  z.string().max(256).refine((key) => !["__proto__", "constructor", "prototype"].includes(key)),
  z.unknown(),
);
const generatedTestStepSchema = z.object({
  action: z.string().min(1).max(128),
  args: generatedStepArgsSchema,
  expectedScreen: boundedTextSchema.optional(),
  label: boundedTextSchema.optional(),
}).strict();
const generatedTestSchema = z.object({
  id: z.string().min(1).max(128),
  name: boundedTextSchema,
  description: z.string().max(16 * 1024),
  path: z.array(boundedTextSchema).max(1000),
  steps: z.array(generatedTestStepSchema).max(10_000),
  format: z.enum(["flow_run", "steps"]),
}).strict();
const generatedTestSuiteSchema = z.object({
  explorationId: z.string().min(1).max(128),
  generatedAt: z.string().min(1).max(128),
  tests: z.array(generatedTestSchema).max(1000),
}).strict();

function parseExploration(value: unknown, expectedId?: string): ExplorationResult {
  const result = explorationResultSchema.safeParse(value);
  if (!result.success || (expectedId !== undefined && result.data.id !== expectedId)) {
    throw new MobileError("Exploration is corrupted: invalid structure.", "EXPLORATION_CORRUPTED");
  }
  return result.data;
}

function parseTestSuite(value: unknown, expectedId: string): GeneratedTestSuite {
  const result = generatedTestSuiteSchema.safeParse(value);
  if (!result.success || result.data.explorationId !== expectedId) {
    throw new MobileError("Generated test suite is corrupted: invalid structure.", "TESTS_CORRUPTED");
  }
  return result.data;
}

// ── ExplorationStore ──

export class ExplorationStore {
  private readonly storeDir: string;

  constructor(cwd?: string) {
    const envDir = process.env.CLAUDE_MOBILE_EXPLORATIONS_DIR;
    if (envDir !== undefined && (
      envDir.length === 0 || envDir.length > 4096 || envDir.includes("\0")
    )) {
      throw new MobileError("Invalid exploration storage directory.", "INVALID_EXPLORATION_DIRECTORY");
    }
    this.storeDir = envDir
      ? resolve(envDir)
      : join(cwd ?? process.cwd(), DEFAULT_DIR);
  }

  // ── Private ──

  private getExplorationPath(id: string): string {
    const safeId = sanitizeId(id);
    const filePath = join(this.storeDir, `${safeId}.json`);
    validatePathContainment(filePath, this.storeDir);
    return filePath;
  }

  private getTestsPath(explorationId: string): string {
    const safeId = sanitizeId(explorationId);
    const filePath = join(this.storeDir, `${safeId}-tests.json`);
    validatePathContainment(filePath, this.storeDir);
    return filePath;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.storeDir, { recursive: true, mode: DIR_MODE });
    const metadata = await lstat(this.storeDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new MobileError("Exploration storage path is not a private directory.", "INVALID_EXPLORATION_DIRECTORY");
    }
  }

  // ── Exploration persistence ──

  async saveExploration(result: ExplorationResult): Promise<string> {
    await this.ensureDir();

    // Check limit
    const existing = await this.listExplorations();
    if (existing.length >= MAX_EXPLORATIONS) {
      throw new MobileError(
        `Exploration limit reached: ${MAX_EXPLORATIONS}. Delete old explorations first.`,
        "EXPLORATION_LIMIT",
      );
    }

    const filePath = this.getExplorationPath(result.id);
    parseExploration(result, result.id);
    await writeJsonAtomic(filePath, result, FILE_MODE);
    return result.id;
  }

  async getExploration(id: string): Promise<ExplorationResult> {
    await this.ensureDir();
    const filePath = this.getExplorationPath(id);
    return readJsonOrDefault(
      filePath,
      () => {
        throw new MobileError(
          `Exploration "${id}" not found. Use autopilot(action:'explore') to create one.`,
          "EXPLORATION_NOT_FOUND",
        );
      },
      "exploration",
    ).then((value) => parseExploration(value, id));
  }

  async listExplorations(): Promise<Array<{ id: string; package: string; date: string; screens: number }>> {
    await this.ensureDir();
    const explorations: Array<{ id: string; package: string; date: string; screens: number }> = [];
    const directory = await opendir(this.storeDir);
    let scanned = 0;
    for await (const entry of directory) {
      scanned += 1;
      if (scanned > MAX_STORE_ENTRIES) {
        throw new MobileError("Exploration storage contains too many entries.", "EXPLORATION_LIMIT");
      }
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.endsWith("-tests.json")) {
        continue;
      }
      const filePath = join(this.storeDir, entry.name);
      try {
        const exploration = parseExploration(await readJsonOrDefault(
          filePath,
          () => {
            throw new MobileError("Exploration disappeared during listing.", "EXPLORATION_NOT_FOUND");
          },
          "exploration",
        ));
        explorations.push({
          id: exploration.id,
          package: exploration.package,
          date: exploration.completedAt,
          screens: exploration.stats.screensFound,
        });
      } catch {
        // Corrupt entries are unavailable but still count toward the storage scan limit.
      }
    }
    return explorations;
  }

  // ── Test persistence ──

  async saveTests(suite: GeneratedTestSuite): Promise<void> {
    await this.ensureDir();
    const filePath = this.getTestsPath(suite.explorationId);
    parseTestSuite(suite, suite.explorationId);
    await writeJsonAtomic(filePath, suite, FILE_MODE);
  }

  async getTests(explorationId: string): Promise<GeneratedTestSuite> {
    await this.ensureDir();
    const filePath = this.getTestsPath(explorationId);
    return readJsonOrDefault(
      filePath,
      () => {
        throw new MobileError(
          `Tests for exploration "${explorationId}" not found. Use autopilot(action:'generate') to create them.`,
          "TESTS_NOT_FOUND",
        );
      },
      "generated test suite",
    ).then((value) => parseTestSuite(value, explorationId));
  }

  getStoreDir(): string {
    return this.storeDir;
  }
}
