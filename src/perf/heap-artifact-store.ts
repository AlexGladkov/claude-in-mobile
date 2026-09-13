import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { chmod, lstat, mkdir, rename, stat, unlink } from "fs/promises";
import { join, resolve } from "path";
import { z } from "zod";

import type {
  HeapSnapshotAdapter,
  HeapSnapshotCapture,
  HeapSnapshotOptions,
} from "../adapters/platform-adapter.js";
import { MobileError, ValidationError } from "../errors.js";
import { validatePathContainment } from "../utils/sanitize.js";
import { readJsonOrDefault, writeJsonAtomic } from "../utils/json-file.js";
import { privateRuntimeDir, readPrivateDirectory } from "../utils/private-storage.js";
import type { HeapSnapshotArtifact } from "./types.js";

const HEAP_NAMESPACE = "heap-snapshots";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_ARTIFACT_SIZE = 128 * 1024 * 1024;
const MAX_TOTAL_SIZE = 512 * 1024 * 1024;
const MAX_ARTIFACTS = 16;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DIRECTORY_ENTRIES = 1024;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HEAP_EXTENSION_BY_FORMAT: Record<HeapSnapshotCapture["format"], string> = {
  "android-hprof": "hprof",
  "chrome-heapsnapshot": "heapsnapshot",
  "xctrace-allocations": "allocations.trace.zip",
};

interface StoredHeapMetadata extends Omit<HeapSnapshotArtifact, "path"> {
  fileName: string;
}

const SafeTextSchema = z.string().min(1).max(4096).regex(SAFE_TEXT);
const TimestampSchema = SafeTextSchema.max(64).refine(
  (value) => Number.isFinite(Date.parse(value)),
  "invalid timestamp",
);
const NonNegativeNumberSchema = z.number().finite().nonnegative();
const HeapSummarySchema = z.object({
  sizeBytes: NonNegativeNumberSchema,
  nodeCount: NonNegativeNumberSchema.optional(),
  edgeCount: NonNegativeNumberSchema.optional(),
  traceFunctionCount: NonNegativeNumberSchema.optional(),
  totalPssMb: NonNegativeNumberSchema.optional(),
  nativeHeapMb: NonNegativeNumberSchema.optional(),
  dalvikHeapMb: NonNegativeNumberSchema.optional(),
  instrumentCount: NonNegativeNumberSchema.optional(),
  warnings: z.array(SafeTextSchema).max(256),
}).strict();
const StoredHeapMetadataSchema = z.object({
  artifactId: z.string().regex(ARTIFACT_ID),
  platform: z.enum(["android", "ios", "web", "desktop", "aurora", "harmony"]),
  capturedAt: TimestampSchema,
  format: z.enum(["android-hprof", "chrome-heapsnapshot", "xctrace-allocations"]),
  mimeType: SafeTextSchema,
  producer: SafeTextSchema,
  packageName: SafeTextSchema.optional(),
  session: SafeTextSchema.optional(),
  summary: HeapSummarySchema,
  fileName: SafeTextSchema,
  sizeBytes: NonNegativeNumberSchema.max(MAX_ARTIFACT_SIZE),
  sha256: z.string().regex(SHA256),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  sensitivity: z.literal("secret"),
}).strict();

function parseStoredHeapMetadata(
  value: unknown,
  artifactId: string,
): StoredHeapMetadata {
  const parsed = StoredHeapMetadataSchema.safeParse(value);
  if (
    !parsed.success
    || parsed.data.artifactId !== artifactId
    || parsed.data.fileName
      !== `${artifactId}.${HEAP_EXTENSION_BY_FORMAT[parsed.data.format]}`
    || parsed.data.summary.sizeBytes !== parsed.data.sizeBytes
    || Date.parse(parsed.data.expiresAt) < Date.parse(parsed.data.createdAt)
  ) {
    throw new MobileError(
      `Heap artifact "${artifactId}" has invalid metadata.`,
      "HEAP_ARTIFACT_CORRUPTED",
    );
  }
  return parsed.data;
}

export class HeapArtifactStore {
  private readonly rootDir: string;
  private readonly ttlMs: number;
  private finalizeTail = Promise.resolve();

  constructor(rootDir?: string, ttlMs = DEFAULT_TTL_MS) {
    this.rootDir = resolve(
      rootDir ?? process.env.MCP_DEVICES_HEAP_DIR ?? privateRuntimeDir(HEAP_NAMESPACE),
    );
    this.ttlMs = ttlMs;
  }

  async capture(
    adapter: HeapSnapshotAdapter,
    options: Omit<HeapSnapshotOptions, "outputPath">,
  ): Promise<HeapSnapshotArtifact> {
    await this.ensureRoot();
    await this.withFinalizeLock(async () => {
      await this.purgeExpired();
      const usage = await this.storageUsage();
      if (usage.count >= MAX_ARTIFACTS) {
        throw new MobileError(
          `Heap artifact limit reached (${MAX_ARTIFACTS}). Delete an artifact before capturing another heap.`,
          "HEAP_STORAGE_FULL",
        );
      }
    });

    const artifactId = randomUUID();
    const partialPath = this.childPath(`${artifactId}.${randomUUID()}.partial`);
    let capture: HeapSnapshotCapture;
    try {
      capture = await adapter.captureHeapSnapshot({ ...options, outputPath: partialPath });
      if (capture.format !== adapter.heapSnapshotFormat) {
        throw new MobileError("Heap backend returned a format that does not match its declared capability.", "HEAP_BACKEND_INVALID");
      }
      const details = await lstat(partialPath);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new MobileError("Heap backend did not produce a regular file.", "HEAP_BACKEND_INVALID");
      }
      if (details.size === 0) throw new ValidationError("Heap snapshot is empty; no artifact was written.");
      if (details.size > MAX_ARTIFACT_SIZE) {
        throw new ValidationError(
          `Heap snapshot is ${(details.size / 1024 / 1024).toFixed(1)}MB; maximum is ${MAX_ARTIFACT_SIZE / 1024 / 1024}MB.`,
        );
      }
      await chmod(partialPath, FILE_MODE);
      capture.summary.sizeBytes = details.size;
      const sha256 = await hashFile(partialPath);
      return await this.withFinalizeLock(async () => {
        await this.purgeExpired();
        const usage = await this.storageUsage();
        if (usage.count >= MAX_ARTIFACTS || usage.bytes + details.size > MAX_TOTAL_SIZE) {
          throw new MobileError(
            `Heap storage would exceed ${MAX_TOTAL_SIZE / 1024 / 1024}MB or ${MAX_ARTIFACTS} artifacts. Delete older artifacts first.`,
            "HEAP_STORAGE_FULL",
          );
        }
        return this.finalizeArtifact(artifactId, partialPath, capture, details.size, sha256);
      });
    } catch (error) {
      await unlink(partialPath).catch(() => {});
      throw error;
    }
  }

  async get(artifactId: string): Promise<HeapSnapshotArtifact> {
    this.validateArtifactId(artifactId);
    await this.ensureRoot();
    await this.purgeExpired();
    const metadataPath = this.childPath(`${artifactId}.metadata.json`);
    const stored = await readJsonOrDefault(
      metadataPath,
      () => {
        throw new MobileError(
          `Heap artifact "${artifactId}" was not found.`,
          "HEAP_ARTIFACT_NOT_FOUND",
        );
      },
      "heap artifact metadata",
    );
    const metadata = parseStoredHeapMetadata(stored, artifactId);
    const path = this.childPath(metadata.fileName);
    const details = await lstat(path).catch(() => null);
    if (!details?.isFile() || details.isSymbolicLink()) {
      throw new MobileError(`Heap artifact "${artifactId}" is missing or invalid.`, "HEAP_ARTIFACT_CORRUPTED");
    }
    return { ...metadata, path };
  }

  async delete(artifactId: string): Promise<void> {
    const artifact = await this.get(artifactId);
    await Promise.allSettled([
      unlink(artifact.path),
      unlink(this.childPath(`${artifactId}.metadata.json`)),
    ]);
  }

  private async finalizeArtifact(
    artifactId: string,
    partialPath: string,
    capture: HeapSnapshotCapture,
    sizeBytes: number,
    sha256: string,
  ): Promise<HeapSnapshotArtifact> {
    const fileName = `${artifactId}.${HEAP_EXTENSION_BY_FORMAT[capture.format]}`;
    const path = this.childPath(fileName);
    const metadataPath = this.childPath(`${artifactId}.metadata.json`);
    const partialMetadataPath = this.childPath(`${artifactId}.${randomUUID()}.metadata.partial`);
    const createdAt = new Date().toISOString();
    const artifact: HeapSnapshotArtifact = {
      artifactId,
      platform: capture.platform,
      capturedAt: capture.capturedAt,
      format: capture.format,
      mimeType: capture.mimeType,
      producer: capture.producer,
      packageName: capture.packageName,
      session: capture.session,
      summary: capture.summary,
      path,
      sizeBytes,
      sha256,
      createdAt,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
      sensitivity: "secret",
    };
    const { path: _path, ...metadataFields } = artifact;
    const metadata: StoredHeapMetadata = { ...metadataFields, fileName };
    try {
      await writeJsonAtomic(partialMetadataPath, metadata, FILE_MODE);
      await rename(partialPath, path);
      await rename(partialMetadataPath, metadataPath);
      return artifact;
    } catch (error) {
      await Promise.allSettled([unlink(partialMetadataPath), unlink(path), unlink(metadataPath)]);
      throw error;
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: DIR_MODE });
    const details = await lstat(this.rootDir);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new MobileError("Heap artifact root must be a regular directory.", "HEAP_STORAGE_INVALID");
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
      throw new ValidationError("artifactId must be a UUID generated by heap capture.");
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
          "heap artifact metadata",
        );
        const metadata = parseStoredHeapMetadata(
          stored,
          entry.name.slice(0, -".metadata.json".length),
        );
        if (Date.parse(metadata.expiresAt) > now) return;
        await Promise.allSettled([unlink(this.childPath(metadata.fileName)), unlink(path)]);
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

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
