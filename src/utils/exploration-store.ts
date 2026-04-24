/**
 * File persistence for exploration data and generated tests.
 * Stores JSON files in `.test-explorations/` directory.
 */

import { mkdir, readFile, writeFile, readdir } from "fs/promises";
import { join, resolve } from "path";
import { validatePathContainment } from "./sanitize.js";
import { MobileError } from "../errors.js";
import type { ExplorationResult, GeneratedTestSuite } from "../autopilot/types.js";

// ── Constants ──

const DEFAULT_DIR = ".test-explorations";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_EXPLORATIONS = 100;

// ── Helpers ──

/**
 * Sanitize an exploration ID to prevent path traversal.
 * Only alphanumeric, hyphens, underscores, and dots allowed.
 */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._\-]/g, "_");
}

// ── ExplorationStore ──

export class ExplorationStore {
  private readonly storeDir: string;

  constructor(cwd?: string) {
    const envDir = process.env.CLAUDE_MOBILE_EXPLORATIONS_DIR;
    if (envDir) {
      this.storeDir = resolve(envDir);
    } else {
      this.storeDir = join(cwd ?? process.cwd(), DEFAULT_DIR);
    }
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
    await writeFile(filePath, JSON.stringify(result, null, 2), { mode: FILE_MODE });
    return result.id;
  }

  async getExploration(id: string): Promise<ExplorationResult> {
    const filePath = this.getExplorationPath(id);
    let data: string;
    try {
      data = await readFile(filePath, "utf-8");
    } catch {
      throw new MobileError(
        `Exploration "${id}" not found. Use autopilot(action:'explore') to create one.`,
        "EXPLORATION_NOT_FOUND",
      );
    }

    try {
      return JSON.parse(data) as ExplorationResult;
    } catch {
      throw new MobileError(
        `Exploration "${id}" corrupted: invalid JSON.`,
        "EXPLORATION_CORRUPTED",
      );
    }
  }

  async listExplorations(): Promise<Array<{ id: string; package: string; date: string; screens: number }>> {
    try {
      await this.ensureDir();
      const files = await readdir(this.storeDir);
      const explorations: Array<{ id: string; package: string; date: string; screens: number }> = [];

      for (const file of files) {
        if (!file.endsWith(".json") || file.endsWith("-tests.json")) continue;

        const filePath = join(this.storeDir, file);
        try {
          const data = await readFile(filePath, "utf-8");
          const exploration = JSON.parse(data) as ExplorationResult;
          explorations.push({
            id: exploration.id,
            package: exploration.package,
            date: exploration.completedAt,
            screens: exploration.stats.screensFound,
          });
        } catch {
          // Skip corrupted files
        }
      }

      return explorations;
    } catch {
      return [];
    }
  }

  // ── Test persistence ──

  async saveTests(suite: GeneratedTestSuite): Promise<void> {
    await this.ensureDir();
    const filePath = this.getTestsPath(suite.explorationId);
    await writeFile(filePath, JSON.stringify(suite, null, 2), { mode: FILE_MODE });
  }

  async getTests(explorationId: string): Promise<GeneratedTestSuite> {
    const filePath = this.getTestsPath(explorationId);
    let data: string;
    try {
      data = await readFile(filePath, "utf-8");
    } catch {
      throw new MobileError(
        `Tests for exploration "${explorationId}" not found. Use autopilot(action:'generate') to create them.`,
        "TESTS_NOT_FOUND",
      );
    }

    try {
      return JSON.parse(data) as GeneratedTestSuite;
    } catch {
      throw new MobileError(
        `Tests for exploration "${explorationId}" corrupted: invalid JSON.`,
        "TESTS_CORRUPTED",
      );
    }
  }

  getStoreDir(): string {
    return this.storeDir;
  }
}
