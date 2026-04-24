import { mkdir, readFile, writeFile, unlink, stat, chmod } from "fs/promises";
import { join, resolve } from "path";
import { createHash } from "crypto";
import { validateBaselineName, validatePathContainment } from "./sanitize.js";
import {
  BaselineNotFoundError,
  BaselineExistsError,
  BaselineCorruptedError,
  ValidationError,
  MobileError,
} from "../errors.js";

// ── Types ──

export interface BaselineEntry {
  name: string;
  platform: string;
  tags: string[];
  checksum: string;
  width: number;
  height: number;
  fileSize: number;
  createdAt: string;
  updatedAt: string;
}

interface Manifest {
  version: 1;
  baselines: BaselineEntry[];
}

// ── Constants ──

const DEFAULT_DIR = ".visual-baselines";
const MANIFEST_FILE = "manifest.json";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_BASELINES = 200;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_TOTAL_SIZE = 500 * 1024 * 1024; // 500MB
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── BaselineStore ──

export class BaselineStore {
  private readonly baselinesDir: string;

  constructor(cwd?: string) {
    const envDir = process.env.CLAUDE_MOBILE_BASELINES_DIR;
    if (envDir) {
      this.baselinesDir = resolve(envDir);
    } else {
      this.baselinesDir = join(cwd ?? process.cwd(), DEFAULT_DIR);
    }
  }

  // ── Private ──

  private getBaselinePath(platform: string, name: string): string {
    const filePath = join(this.baselinesDir, platform, `${name}.png`);
    validatePathContainment(filePath, this.baselinesDir);
    return filePath;
  }

  private get manifestPath(): string {
    return join(this.baselinesDir, MANIFEST_FILE);
  }

  private async readManifest(): Promise<Manifest> {
    try {
      const data = await readFile(this.manifestPath, "utf-8");
      return JSON.parse(data) as Manifest;
    } catch {
      return { version: 1, baselines: [] };
    }
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    await this.ensureDir();
    const data = JSON.stringify(manifest, null, 2);
    await writeFile(this.manifestPath, data, { mode: FILE_MODE });
  }

  private async ensureDir(platform?: string): Promise<void> {
    const dir = platform ? join(this.baselinesDir, platform) : this.baselinesDir;
    validatePathContainment(dir, this.baselinesDir);
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
  }

  private computeChecksum(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
  }

  private validateMagicBytes(buffer: Buffer): void {
    if (buffer.length < PNG_MAGIC.length || !buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      throw new ValidationError("Buffer is not a valid PNG image (magic bytes mismatch)");
    }
  }

  private findEntry(manifest: Manifest, name: string, platform: string): BaselineEntry | undefined {
    return manifest.baselines.find(e => e.name === name && e.platform === platform);
  }

  private getTotalSize(manifest: Manifest): number {
    return manifest.baselines.reduce((sum, e) => sum + e.fileSize, 0);
  }

  // ── Public API ──

  async save(
    name: string,
    platform: string,
    pngBuffer: Buffer,
    options?: { tags?: string[]; overwrite?: boolean; width?: number; height?: number },
  ): Promise<BaselineEntry> {
    validateBaselineName(name, "screen_name");
    validateBaselineName(platform, "platform");
    this.validateMagicBytes(pngBuffer);

    if (pngBuffer.length > MAX_FILE_SIZE) {
      throw new ValidationError(`Baseline image too large: ${(pngBuffer.length / 1024 / 1024).toFixed(1)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
    }

    const manifest = await this.readManifest();
    const existing = this.findEntry(manifest, name, platform);

    if (existing && !options?.overwrite) {
      throw new BaselineExistsError(name, platform);
    }

    if (!existing && manifest.baselines.length >= MAX_BASELINES) {
      throw new ValidationError(`Baseline limit reached: ${MAX_BASELINES}. Delete unused baselines first.`);
    }

    const totalSize = this.getTotalSize(manifest) - (existing?.fileSize ?? 0) + pngBuffer.length;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new ValidationError(`Total baseline storage limit exceeded: ${(totalSize / 1024 / 1024).toFixed(0)}MB (max ${MAX_TOTAL_SIZE / 1024 / 1024}MB)`);
    }

    await this.ensureDir(platform);
    const filePath = this.getBaselinePath(platform, name);
    await writeFile(filePath, pngBuffer, { mode: FILE_MODE });

    const now = new Date().toISOString();
    const entry: BaselineEntry = {
      name,
      platform,
      tags: options?.tags ?? [],
      checksum: this.computeChecksum(pngBuffer),
      width: options?.width ?? 0,
      height: options?.height ?? 0,
      fileSize: pngBuffer.length,
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
    return entry;
  }

  async get(name: string, platform: string): Promise<Buffer> {
    validateBaselineName(name, "screen_name");
    const manifest = await this.readManifest();
    const entry = this.findEntry(manifest, name, platform);
    if (!entry) throw new BaselineNotFoundError(name, platform);

    const filePath = this.getBaselinePath(platform, name);
    let buffer: Buffer;
    try {
      buffer = await readFile(filePath);
    } catch {
      throw new BaselineNotFoundError(name, platform);
    }

    // Validate magic bytes
    if (buffer.length < PNG_MAGIC.length || !buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      throw new BaselineCorruptedError(name, "not a valid PNG file");
    }

    // Validate checksum
    const actualChecksum = this.computeChecksum(buffer);
    if (actualChecksum !== entry.checksum) {
      throw new BaselineCorruptedError(name, "checksum mismatch — file was modified externally");
    }

    return buffer;
  }

  async update(name: string, platform: string, pngBuffer: Buffer, reason?: string): Promise<BaselineEntry> {
    validateBaselineName(name, "screen_name");
    const manifest = await this.readManifest();
    const entry = this.findEntry(manifest, name, platform);
    if (!entry) throw new BaselineNotFoundError(name, platform);

    // Reuse save with overwrite
    return this.save(name, platform, pngBuffer, {
      tags: entry.tags,
      overwrite: true,
      width: entry.width,
      height: entry.height,
    });
  }

  async delete(name: string, platform: string): Promise<void> {
    validateBaselineName(name, "screen_name");
    const manifest = await this.readManifest();
    const entry = this.findEntry(manifest, name, platform);
    if (!entry) throw new BaselineNotFoundError(name, platform);

    const filePath = this.getBaselinePath(platform, name);
    try {
      await unlink(filePath);
    } catch {
      // File already gone — ok
    }

    manifest.baselines = manifest.baselines.filter(e => !(e.name === name && e.platform === platform));
    await this.writeManifest(manifest);
  }

  async list(platform?: string, tag?: string): Promise<BaselineEntry[]> {
    const manifest = await this.readManifest();
    let entries = manifest.baselines;
    if (platform) entries = entries.filter(e => e.platform === platform);
    if (tag) entries = entries.filter(e => e.tags.includes(tag));
    return entries;
  }

  async getEntry(name: string, platform: string): Promise<BaselineEntry | undefined> {
    const manifest = await this.readManifest();
    return this.findEntry(manifest, name, platform);
  }

  getBaselinesDir(): string {
    return this.baselinesDir;
  }
}
