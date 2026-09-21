import { requireHeapSnapshot } from "../adapters/platform-adapter.js";
import type { HeapSnapshotOptions } from "../adapters/platform-adapter.js";
import type { DeviceManager, Platform } from "../device-manager.js";
import { MobileError } from "../errors.js";
import { HeapArtifactStore } from "./heap-artifact-store.js";
import type {
  HeapSnapshotArtifact,
  HeapSnapshotDiff,
  HeapSnapshotDiffMetric,
} from "./types.js";

const MAX_ACTIVE_CAPTURES = 4;

type CaptureOptions = Omit<HeapSnapshotOptions, "outputPath">;

export class HeapSnapshotManager {
  private readonly active = new Set<string>();

  constructor(private readonly artifacts = new HeapArtifactStore()) {}

  async capture(
    deviceManager: DeviceManager,
    platform: Platform,
    options: CaptureOptions,
  ): Promise<HeapSnapshotArtifact> {
    if (this.active.size >= MAX_ACTIVE_CAPTURES) {
      throw new MobileError(
        `Heap capture limit reached (${MAX_ACTIVE_CAPTURES}). Wait for an active capture to finish.`,
        "HEAP_CAPTURE_LIMIT",
      );
    }
    const adapter = requireHeapSnapshot(deviceManager.getAdapter(platform, options.deviceId));
    const key = [platform, options.deviceId ?? "default", options.packageName ?? options.session ?? "default"].join(":");
    if (this.active.has(key)) {
      throw new MobileError(`A heap capture is already active for ${key}.`, "HEAP_CAPTURE_ACTIVE");
    }
    this.active.add(key);
    try {
      const artifact = await this.artifacts.capture(adapter, options);
      if (artifact.platform !== platform) {
        await this.artifacts.delete(artifact.artifactId).catch(() => {});
        throw new MobileError(
          `Heap backend returned platform "${artifact.platform}" for requested platform "${platform}".`,
          "HEAP_BACKEND_INVALID",
        );
      }
      return artifact;
    } finally {
      this.active.delete(key);
    }
  }

  async compare(beforeArtifactId: string, afterArtifactId: string): Promise<HeapSnapshotDiff> {
    const [before, after] = await Promise.all([
      this.artifacts.get(beforeArtifactId),
      this.artifacts.get(afterArtifactId),
    ]);
    if (before.format !== after.format || before.platform !== after.platform) {
      throw new MobileError("Heap comparison requires artifacts from the same platform and format.", "HEAP_DIFF_INCOMPATIBLE");
    }
    if (before.packageName !== after.packageName || before.session !== after.session) {
      throw new MobileError("Heap comparison requires artifacts from the same package or browser session.", "HEAP_DIFF_INCOMPATIBLE");
    }

    const metrics: HeapSnapshotDiffMetric[] = [];
    addMetric(metrics, "artifactSize", before.sizeBytes, after.sizeBytes, "bytes");
    addMetric(metrics, "nodeCount", before.summary.nodeCount, after.summary.nodeCount, "count");
    addMetric(metrics, "edgeCount", before.summary.edgeCount, after.summary.edgeCount, "count");
    addMetric(metrics, "traceFunctionCount", before.summary.traceFunctionCount, after.summary.traceFunctionCount, "count");
    addMetric(metrics, "totalPss", before.summary.totalPssMb, after.summary.totalPssMb, "mb");
    addMetric(metrics, "nativeHeap", before.summary.nativeHeapMb, after.summary.nativeHeapMb, "mb");
    addMetric(metrics, "dalvikHeap", before.summary.dalvikHeapMb, after.summary.dalvikHeapMb, "mb");
    addMetric(metrics, "instrumentCount", before.summary.instrumentCount, after.summary.instrumentCount, "count");
    return {
      platform: before.platform,
      beforeArtifactId,
      afterArtifactId,
      metrics,
    };
  }

  async deleteArtifact(artifactId: string): Promise<void> {
    await this.artifacts.delete(artifactId);
  }
}

function addMetric(
  metrics: HeapSnapshotDiffMetric[],
  metric: string,
  before: number | undefined,
  after: number | undefined,
  unit: HeapSnapshotDiffMetric["unit"],
): void {
  if (before === undefined || after === undefined) return;
  const delta = rounded(after - before);
  metrics.push({
    metric,
    before,
    after,
    delta,
    deltaPercent: before === 0 ? null : rounded((delta / before) * 100),
    unit,
  });
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}
