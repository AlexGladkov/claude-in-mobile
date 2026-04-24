/**
 * JSON-based performance baseline store.
 * Pattern similar to BaselineStore but stores JSON snapshots instead of PNG images.
 */

import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { join, resolve } from "path";
import { validateBaselineName, validatePathContainment } from "./sanitize.js";
import { MobileError } from "../errors.js";
import type { PerfSnapshot, PerfBaseline } from "../perf/types.js";

// ── Types ──

interface PerfManifest {
  version: 1;
  baselines: PerfBaselineEntry[];
}

interface PerfBaselineEntry {
  name: string;
  platform: string;
  createdAt: string;
  updatedAt: string;
}

// ── Constants ──

const DEFAULT_DIR = ".perf-baselines";
const MANIFEST_FILE = "manifest.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_BASELINES = 200;

// ── PerfBaselineStore ──

export class PerfBaselineStore {
  private readonly baselinesDir: string;

  constructor(cwd?: string) {
    const envDir = process.env.CLAUDE_MOBILE_PERF_BASELINES_DIR;
    if (envDir) {
      this.baselinesDir = resolve(envDir);
    } else {
      this.baselinesDir = join(cwd ?? process.cwd(), DEFAULT_DIR);
    }
  }

  // ── Private ──

  private getBaselinePath(platform: string, name: string): string {
    const filePath = join(this.baselinesDir, `${platform}-${name}.json`);
    validatePathContainment(filePath, this.baselinesDir);
    return filePath;
  }

  private get manifestPath(): string {
    return join(this.baselinesDir, MANIFEST_FILE);
  }

  private async readManifest(): Promise<PerfManifest> {
    try {
      const data = await readFile(this.manifestPath, "utf-8");
      return JSON.parse(data) as PerfManifest;
    } catch {
      return { version: 1, baselines: [] };
    }
  }

  private async writeManifest(manifest: PerfManifest): Promise<void> {
    await this.ensureDir();
    const data = JSON.stringify(manifest, null, 2);
    await writeFile(this.manifestPath, data, { mode: FILE_MODE });
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.baselinesDir, { recursive: true, mode: DIR_MODE });
  }

  private findEntry(
    manifest: PerfManifest,
    name: string,
    platform: string,
  ): PerfBaselineEntry | undefined {
    return manifest.baselines.find((e) => e.name === name && e.platform === platform);
  }

  // ── Public API ──

  async save(
    name: string,
    platform: string,
    snapshot: PerfSnapshot,
    overwrite = false,
  ): Promise<PerfBaseline> {
    validateBaselineName(name, "baseline_name");
    validateBaselineName(platform, "platform");

    const manifest = await this.readManifest();
    const existing = this.findEntry(manifest, name, platform);

    if (existing && !overwrite) {
      throw new MobileError(
        `Performance baseline "${name}" already exists for ${platform}. Use overwrite:true to replace.`,
        "PERF_BASELINE_EXISTS",
      );
    }

    if (!existing && manifest.baselines.length >= MAX_BASELINES) {
      throw new MobileError(
        `Performance baseline limit reached: ${MAX_BASELINES}. Delete unused baselines first.`,
        "VALIDATION_ERROR",
      );
    }

    await this.ensureDir();
    const filePath = this.getBaselinePath(platform, name);

    const now = new Date().toISOString();
    const baseline: PerfBaseline = {
      name,
      platform,
      snapshot,
      createdAt: existing?.createdAt ?? now,
    };

    await writeFile(filePath, JSON.stringify(baseline, null, 2), { mode: FILE_MODE });

    const entry: PerfBaselineEntry = {
      name,
      platform,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (existing) {
      const idx = manifest.baselines.indexOf(existing);
      manifest.baselines[idx] = entry;
    } else {
      manifest.baselines.push(entry);
    }

    await this.writeManifest(manifest);
    return baseline;
  }

  async get(name: string, platform: string): Promise<PerfBaseline> {
    validateBaselineName(name, "baseline_name");
    const manifest = await this.readManifest();
    const entry = this.findEntry(manifest, name, platform);
    if (!entry) {
      throw new MobileError(
        `Performance baseline "${name}" not found for ${platform}. Use performance(action:'baseline') to create one.`,
        "PERF_BASELINE_NOT_FOUND",
      );
    }

    const filePath = this.getBaselinePath(platform, name);
    let data: string;
    try {
      data = await readFile(filePath, "utf-8");
    } catch {
      throw new MobileError(
        `Performance baseline "${name}" not found for ${platform}. Use performance(action:'baseline') to create one.`,
        "PERF_BASELINE_NOT_FOUND",
      );
    }

    try {
      return JSON.parse(data) as PerfBaseline;
    } catch {
      throw new MobileError(
        `Performance baseline "${name}" corrupted: invalid JSON. Delete and recreate.`,
        "PERF_BASELINE_CORRUPTED",
      );
    }
  }

  async list(platform?: string): Promise<PerfBaselineEntry[]> {
    const manifest = await this.readManifest();
    let entries = manifest.baselines;
    if (platform) {
      entries = entries.filter((e) => e.platform === platform);
    }
    return entries;
  }

  async delete(name: string, platform: string): Promise<void> {
    validateBaselineName(name, "baseline_name");
    const manifest = await this.readManifest();
    const entry = this.findEntry(manifest, name, platform);
    if (!entry) {
      throw new MobileError(
        `Performance baseline "${name}" not found for ${platform}.`,
        "PERF_BASELINE_NOT_FOUND",
      );
    }

    const filePath = this.getBaselinePath(platform, name);
    try {
      await unlink(filePath);
    } catch {
      // File already gone — ok
    }

    manifest.baselines = manifest.baselines.filter(
      (e) => !(e.name === name && e.platform === platform),
    );
    await this.writeManifest(manifest);
  }

  async exists(name: string, platform: string): Promise<boolean> {
    const manifest = await this.readManifest();
    return this.findEntry(manifest, name, platform) !== undefined;
  }

  getBaselinesDir(): string {
    return this.baselinesDir;
  }
}
