import { createHash, randomUUID } from "crypto";
import { chmod, lstat, mkdir, rename, stat, unlink, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { z } from "zod";

import type { PerformanceTraceCapture } from "../adapters/platform-adapter.js";
import { MobileError, ValidationError } from "../errors.js";
import type { PerformanceTraceArtifact } from "./types.js";
import { readJsonOrDefault, writeJsonAtomic } from "../utils/json-file.js";
import { validatePathContainment } from "../utils/sanitize.js";
import { privateRuntimeDir, readPrivateDirectory } from "../utils/private-storage.js";

const TRACE_NAMESPACE = "performance-traces";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_ARTIFACT_SIZE = 32 * 1024 * 1024;
const MAX_TOTAL_SIZE = 256 * 1024 * 1024;
const MAX_ARTIFACTS = 64;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DIRECTORY_ENTRIES = 1024;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TRACE_EXTENSION_BY_FORMAT: Record<PerformanceTraceCapture["format"], string> = {
  "chrome-json": "json",
  "perfetto-proto": "perfetto-trace",
  "xctrace-zip": "trace.zip",
};

interface StoredTraceMetadata extends Omit<PerformanceTraceArtifact, "path"> {
  fileName: string;
}
const SafeTextSchema = z.string().min(1).max(4096).regex(SAFE_TEXT);
const TimestampSchema = SafeTextSchema.max(64).refine(
  (value) => Number.isFinite(Date.parse(value)),
  "invalid timestamp",
);
const NonNegativeNumberSchema = z.number().finite().nonnegative();
const FrameStatsSchema = z.object({
  totalFrames: NonNegativeNumberSchema,
  jankyFrames: NonNegativeNumberSchema,
  jankyPercent: NonNegativeNumberSchema,
  p50Ms: NonNegativeNumberSchema.optional(),
  p90Ms: NonNegativeNumberSchema.optional(),
  p95Ms: NonNegativeNumberSchema.optional(),
  p99Ms: NonNegativeNumberSchema.optional(),
}).strict();
const TraceSummarySchema = z.object({
  eventCount: NonNegativeNumberSchema.optional(),
  longTaskCount: NonNegativeNumberSchema.optional(),
  longestTaskMs: NonNegativeNumberSchema.optional(),
  totalLongTaskMs: NonNegativeNumberSchema.optional(),
  layoutCount: NonNegativeNumberSchema.optional(),
  paintCount: NonNegativeNumberSchema.optional(),
  scriptCount: NonNegativeNumberSchema.optional(),
  navigationCount: NonNegativeNumberSchema.optional(),
  frameStats: FrameStatsSchema.optional(),
  sliceCount: NonNegativeNumberSchema.optional(),
  schedSliceCount: NonNegativeNumberSchema.optional(),
  cpuTimeMs: NonNegativeNumberSchema.optional(),
  jankSliceCount: NonNegativeNumberSchema.optional(),
  sampleCount: NonNegativeNumberSchema.optional(),
  instrumentCount: NonNegativeNumberSchema.optional(),
  analysisTool: SafeTextSchema.optional(),
  warnings: z.array(SafeTextSchema).max(256),
}).strict();
const StoredTraceMetadataSchema = z.object({
  artifactId: z.string().regex(ARTIFACT_ID),
  traceId: SafeTextSchema,
  platform: z.enum(["android", "ios", "web", "desktop", "aurora", "harmony"]),
  preset: z.enum(["ui-jank", "startup"]),
  startedAt: TimestampSchema,
  deadlineAt: TimestampSchema,
  endedAt: TimestampSchema,
  durationMs: NonNegativeNumberSchema,
  format: z.enum(["chrome-json", "perfetto-proto", "xctrace-zip"]),
  mimeType: SafeTextSchema,
  producer: SafeTextSchema,
  packageName: SafeTextSchema.optional(),
  session: SafeTextSchema.optional(),
  summary: TraceSummarySchema,
  fileName: SafeTextSchema,
  sizeBytes: NonNegativeNumberSchema.max(MAX_ARTIFACT_SIZE),
  sha256: z.string().regex(SHA256),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  sensitivity: z.literal("sensitive"),
}).strict();

function parseStoredTraceMetadata(
  value: unknown,
  artifactId: string,
): StoredTraceMetadata {
  const parsed = StoredTraceMetadataSchema.safeParse(value);
  if (
    !parsed.success
    || parsed.data.artifactId !== artifactId
    || parsed.data.fileName
      !== `${artifactId}.${TRACE_EXTENSION_BY_FORMAT[parsed.data.format]}`
    || Date.parse(parsed.data.expiresAt) < Date.parse(parsed.data.createdAt)
  ) {
    throw new MobileError(
      `Performance trace artifact "${artifactId}" has invalid metadata.`,
      "PERF_TRACE_CORRUPTED",
    );
  }
  return parsed.data;
}


export class TraceArtifactStore {
  private readonly rootDir: string;
  private readonly ttlMs: number;
  private finalizeTail = Promise.resolve();

  constructor(rootDir?: string, ttlMs = DEFAULT_TTL_MS) {
    this.rootDir = resolve(
      rootDir ?? process.env.MCP_DEVICES_TRACE_DIR ?? privateRuntimeDir(TRACE_NAMESPACE),
    );
    this.ttlMs = ttlMs;
  }

  async save(capture: PerformanceTraceCapture): Promise<PerformanceTraceArtifact> {
    const data = Buffer.from(capture.data.buffer, capture.data.byteOffset, capture.data.byteLength);
    if (data.length === 0) {
      throw new ValidationError("Performance trace is empty; no artifact was written.");
    }
    if (data.length > MAX_ARTIFACT_SIZE) {
      throw new ValidationError(
        `Performance trace is ${(data.length / 1024 / 1024).toFixed(1)}MB; maximum is ${MAX_ARTIFACT_SIZE / 1024 / 1024}MB.`,
      );
    }

    await this.ensureRoot();
    return this.withFinalizeLock(async () => {
      await this.purgeExpired();
      const stored = await this.storageUsage();
      if (stored.count >= MAX_ARTIFACTS) {
        throw new MobileError(
          `Performance trace artifact limit reached (${MAX_ARTIFACTS}). Delete an artifact before capturing another trace.`,
          "PERF_TRACE_STORAGE_FULL",
        );
      }
      if (stored.bytes + data.length > MAX_TOTAL_SIZE) {
        throw new MobileError(
          `Performance trace storage would exceed ${MAX_TOTAL_SIZE / 1024 / 1024}MB. Delete older artifacts first.`,
          "PERF_TRACE_STORAGE_FULL",
        );
      }

      const artifactId = randomUUID();
      const fileName = `${artifactId}.${TRACE_EXTENSION_BY_FORMAT[capture.format]}`;
      const artifactPath = this.childPath(fileName);
      const metadataPath = this.childPath(`${artifactId}.metadata.json`);
      const partialPath = this.childPath(`${artifactId}.${randomUUID()}.partial`);
      const partialMetadataPath = this.childPath(`${artifactId}.${randomUUID()}.metadata.partial`);
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
      const sha256 = createHash("sha256").update(data).digest("hex");

      const artifact: PerformanceTraceArtifact = {
        artifactId,
        traceId: capture.traceId,
        platform: capture.platform,
        preset: capture.preset,
        startedAt: capture.startedAt,
        deadlineAt: capture.deadlineAt,
        endedAt: capture.endedAt,
        durationMs: capture.durationMs,
        format: capture.format,
        mimeType: capture.mimeType,
        producer: capture.producer,
        packageName: capture.packageName,
        session: capture.session,
        summary: capture.summary,
        path: artifactPath,
        sizeBytes: data.length,
        sha256,
        createdAt,
        expiresAt,
        sensitivity: "sensitive",
      };
      const { path: _artifactPath, ...metadataFields } = artifact;
      const metadata: StoredTraceMetadata = { ...metadataFields, fileName };

      try {
        await writeFile(partialPath, data, { flag: "wx", mode: FILE_MODE });
        await writeJsonAtomic(partialMetadataPath, metadata, FILE_MODE);
        await rename(partialPath, artifactPath);
        await rename(partialMetadataPath, metadataPath);
      } catch (error) {
        await Promise.allSettled([
          unlink(partialPath),
          unlink(partialMetadataPath),
          unlink(artifactPath),
          unlink(metadataPath),
        ]);
        throw error;
      }
      return artifact;
    });
  }

  async updateSummary(artifact: PerformanceTraceArtifact): Promise<void> {
    this.validateArtifactId(artifact.artifactId);
    const summary = TraceSummarySchema.safeParse(artifact.summary);
    if (!summary.success) {
      throw new ValidationError("Performance trace summary is invalid.");
    }
    await this.ensureRoot();
    await this.withFinalizeLock(async () => {
      const metadataPath = this.childPath(`${artifact.artifactId}.metadata.json`);
      const stored = await readJsonOrDefault(
        metadataPath,
        () => {
          throw new MobileError(
            `Performance trace artifact "${artifact.artifactId}" was not found.`,
            "PERF_TRACE_NOT_FOUND",
          );
        },
        "performance trace metadata",
      );
      const existing = parseStoredTraceMetadata(stored, artifact.artifactId);
      await writeJsonAtomic(
        metadataPath,
        { ...existing, summary: summary.data },
        FILE_MODE,
      );
    });
  }

  async delete(artifactId: string): Promise<void> {
    this.validateArtifactId(artifactId);
    await this.ensureRoot();
    await this.withFinalizeLock(async () => {
      const metadataPath = this.childPath(`${artifactId}.metadata.json`);
      const stored = await readJsonOrDefault(
        metadataPath,
        () => {
          throw new MobileError(
            `Performance trace artifact "${artifactId}" was not found.`,
            "PERF_TRACE_NOT_FOUND",
          );
        },
        "performance trace metadata",
      );
      const metadata = parseStoredTraceMetadata(stored, artifactId);
      await Promise.allSettled([
        unlink(this.childPath(metadata.fileName)),
        unlink(metadataPath),
      ]);
    });
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: DIR_MODE });
    const details = await lstat(this.rootDir);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new MobileError(
        "Performance trace root must be a regular directory.",
        "PERF_TRACE_STORAGE_INVALID",
      );
    }
    await chmod(this.rootDir, DIR_MODE);
  }

  private childPath(fileName: string): string {
    const path = join(this.rootDir, fileName);
    validatePathContainment(path, this.rootDir);
    return path;
  }

  private validateArtifactId(artifactId: string): void {
    if (!ARTIFACT_ID.test(artifactId)) {
      throw new ValidationError("artifactId must be a UUID generated by performance trace capture.");
    }
  }

  private async purgeExpired(): Promise<void> {
    const entries = await readPrivateDirectory(this.rootDir, MAX_DIRECTORY_ENTRIES);
    const now = Date.now();
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const path = this.childPath(entry.name);
      if (entry.name.endsWith(".partial")) {
        const details = await stat(path).catch(() => null);
        if (details && now - details.mtimeMs > this.ttlMs) await unlink(path).catch(() => {});
        return;
      }
      if (!entry.name.endsWith(".metadata.json")) return;
      try {
        const stored = await readJsonOrDefault(
          path,
          () => null,
          "performance trace metadata",
        );
        const metadata = parseStoredTraceMetadata(
          stored,
          entry.name.slice(0, -".metadata.json".length),
        );
        if (Date.parse(metadata.expiresAt) > now) return;
        await Promise.allSettled([
          unlink(this.childPath(metadata.fileName)),
          unlink(path),
        ]);
      } catch {
        const details = await stat(path).catch(() => null);
        if (details && now - details.mtimeMs > this.ttlMs) await unlink(path).catch(() => {});
      }
    }));
  }

  private async storageUsage(): Promise<{ count: number; bytes: number }> {
    const entries = await readPrivateDirectory(this.rootDir, MAX_DIRECTORY_ENTRIES);
    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(".metadata.json") || entry.name.endsWith(".partial")) continue;
      const details = await stat(this.childPath(entry.name)).catch(() => null);
      if (!details) continue;
      count += 1;
      bytes += details.size;
    }
    return { count, bytes };
  }

  private async withFinalizeLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.finalizeTail;
    let release!: () => void;
    this.finalizeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
