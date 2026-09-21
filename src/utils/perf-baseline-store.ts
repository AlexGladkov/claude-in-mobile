/**
 * JSON-based performance baseline store.
 * Pattern similar to BaselineStore but stores JSON snapshots instead of PNG images.
 */

import { unlink } from "fs/promises";
import { join, resolve } from "path";
import { z } from "zod";
import { validateBaselineName, validatePathContainment } from "./sanitize.js";
import { readJsonOrDefault, writeJsonAtomic } from "./json-file.js";
import { ensurePrivateDirectory } from "./private-storage.js";
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
const MAX_MANIFEST_FILE_SIZE = 1024 * 1024;
const MAX_BASELINE_FILE_SIZE = 2 * 1024 * 1024;
const finiteNumberSchema = z.number().finite();
const perfSnapshotSchema = z.object({
  platform: z.string().min(1).max(128),
  timestamp: z.string().datetime(),
  packageName: z.string().min(1).max(512).optional(),
  memory: z.object({
    usedMb: finiteNumberSchema.nonnegative(),
    totalMb: finiteNumberSchema.nonnegative(),
  }).strict().nullable(),
  cpu: z.object({
    appPercent: finiteNumberSchema,
  }).strict().nullable(),
  fps: z.object({
    current: finiteNumberSchema,
    jankyFrames: finiteNumberSchema.nonnegative().optional(),
    totalFrames: finiteNumberSchema.nonnegative().optional(),
  }).strict().nullable(),
  battery: z.object({
    level: finiteNumberSchema,
    temperature: finiteNumberSchema.optional(),
    charging: z.boolean(),
  }).strict().nullable(),
  crashes: z.array(z.object({
    type: z.enum(["crash", "anr", "native_crash"]),
    timestamp: z.string().max(256),
    process: z.string().max(512).optional(),
    summary: z.string().max(16_384),
  }).strict()).max(1_000),
}).strict();
const perfBaselineSchema = z.object({
  name: z.string().min(1).max(128),
  platform: z.string().min(1).max(128),
  snapshot: perfSnapshotSchema,
  createdAt: z.string().datetime(),
}).strict();
const perfBaselineEntrySchema = z.object({
  name: z.string().min(1).max(128),
  platform: z.string().min(1).max(128),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
const perfManifestSchema = z.object({
  version: z.literal(1),
  baselines: z.array(perfBaselineEntrySchema).max(MAX_BASELINES),
}).strict();

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
    await ensurePrivateDirectory(this.baselinesDir);
    const manifest = await readJsonOrDefault(
      this.manifestPath,
      (): PerfManifest => ({ version: 1, baselines: [] }),
      "performance baseline manifest",
      MAX_MANIFEST_FILE_SIZE,
    );
    const result = perfManifestSchema.safeParse(manifest);
    if (!result.success) {
      throw new MobileError(
        "Performance baseline manifest is corrupted or has an unsupported version.",
        "PERF_BASELINE_CORRUPTED",
      );
    }
    return result.data;
  }

  private async writeManifest(manifest: PerfManifest): Promise<void> {
    await this.ensureDir();
    await writeJsonAtomic(this.manifestPath, manifest, FILE_MODE);
  }

  private async ensureDir(): Promise<void> {
    await ensurePrivateDirectory(this.baselinesDir);
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
    const snapshotResult = perfSnapshotSchema.safeParse(snapshot);
    if (!snapshotResult.success) {
      throw new MobileError("Performance snapshot is invalid.", "VALIDATION_ERROR");
    }

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
    const baseline: PerfBaseline = perfBaselineSchema.parse({
      name,
      platform,
      snapshot: snapshotResult.data,
      createdAt: existing?.createdAt ?? now,
    });

    const serializedSize = Buffer.byteLength(JSON.stringify(baseline), "utf8");
    if (serializedSize > MAX_BASELINE_FILE_SIZE) {
      throw new MobileError("Performance baseline exceeds the size limit.", "VALIDATION_ERROR");
    }
    await writeJsonAtomic(filePath, baseline, FILE_MODE);

    const entry: PerfBaselineEntry = perfBaselineEntrySchema.parse({
      name,
      platform,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

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
    validateBaselineName(platform, "platform");
    const manifest = await this.readManifest();
    const entry = this.findEntry(manifest, name, platform);
    if (!entry) {
      throw new MobileError(
        `Performance baseline "${name}" not found for ${platform}. Use performance(action:'baseline') to create one.`,
        "PERF_BASELINE_NOT_FOUND",
      );
    }

    const filePath = this.getBaselinePath(platform, name);
    let baseline: unknown;
    try {
      baseline = await readJsonOrDefault(
        filePath,
        () => {
          throw new MobileError(
            `Performance baseline "${name}" not found for ${platform}. Use performance(action:'baseline') to create one.`,
            "PERF_BASELINE_NOT_FOUND",
          );
        },
        `performance baseline "${name}"`,
        MAX_BASELINE_FILE_SIZE,
      );
    } catch (error) {
      if (error instanceof MobileError && error.code === "PERF_BASELINE_NOT_FOUND") throw error;
      throw new MobileError(
        `Performance baseline "${name}" is corrupted, oversized, or unreadable. Delete and recreate.`,
        "PERF_BASELINE_CORRUPTED",
      );
    }
    const result = perfBaselineSchema.safeParse(baseline);
    if (!result.success) {
      throw new MobileError(
        `Performance baseline "${name}" has an invalid structure. Delete and recreate.`,
        "PERF_BASELINE_CORRUPTED",
      );
    }
    return result.data;
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
    validateBaselineName(platform, "platform");
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
