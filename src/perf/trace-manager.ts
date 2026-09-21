import type { Platform } from "../device-manager.js";
import type { DeviceManager } from "../device-manager.js";
import { requirePerformanceTrace } from "../adapters/platform-adapter.js";
import type {
  PerformanceTraceAdapter,
  PerformanceTraceHandle,
  PerformanceTraceStartOptions,
} from "../adapters/platform-adapter.js";
import { MobileError, ValidationError } from "../errors.js";
import type { PerformanceTraceArtifact, PerformanceTraceStatus } from "./types.js";
import { TraceArtifactStore } from "./trace-artifact-store.js";
import { analyzePerfettoTrace } from "./trace-processor.js";

const MAX_ACTIVE_TRACES = 8;
const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ActiveTrace {
  handle: PerformanceTraceHandle;
  adapter: PerformanceTraceAdapter;
  stopPromise?: Promise<PerformanceTraceArtifact>;
}

export class PerformanceTraceManager {
  private readonly active = new Map<string, ActiveTrace>();

  constructor(private readonly artifacts = new TraceArtifactStore()) {}

  async start(
    deviceManager: DeviceManager,
    platform: Platform,
    options: PerformanceTraceStartOptions,
  ): Promise<PerformanceTraceHandle> {
    if (this.active.size >= MAX_ACTIVE_TRACES) {
      throw new MobileError(
        `Performance trace limit reached (${MAX_ACTIVE_TRACES}). Stop an active trace before starting another.`,
        "PERF_TRACE_LIMIT",
      );
    }
    const adapter = requirePerformanceTrace(deviceManager.getAdapter(platform, options.deviceId));
    const handle = await adapter.startPerformanceTrace(options);
    if (handle.platform !== platform) {
      throw new MobileError(
        `Performance trace backend returned platform "${handle.platform}" for requested platform "${platform}".`,
        "PERF_TRACE_BACKEND_INVALID",
      );
    }
    if (!TRACE_ID.test(handle.traceId) || this.active.has(handle.traceId)) {
      throw new MobileError(
        "Performance trace backend returned an invalid or duplicate trace id.",
        "PERF_TRACE_BACKEND_INVALID",
      );
    }
    this.active.set(handle.traceId, { handle, adapter });
    return handle;
  }

  async stop(traceId: string): Promise<PerformanceTraceArtifact> {
    this.validateTraceId(traceId);
    const active = this.active.get(traceId);
    if (!active) {
      throw new MobileError(
        `Active performance trace "${traceId}" was not found. It may already be stopped or belong to another server process.`,
        "PERF_TRACE_NOT_FOUND",
      );
    }
    if (!active.stopPromise) {
      active.stopPromise = active.adapter
        .stopPerformanceTrace(traceId)
        .then(async (capture) => {
          const artifact = await this.artifacts.save(capture);
          if (artifact.format !== "perfetto-proto") return artifact;
          const analysis = await analyzePerfettoTrace(artifact.path, artifact.packageName);
          artifact.summary = {
            ...artifact.summary,
            ...analysis,
            warnings: [
              ...artifact.summary.warnings,
              ...(analysis.warnings ?? []),
            ],
          };
          await this.artifacts.updateSummary(artifact);
          return artifact;
        });
      void active.stopPromise.finally(() => {
        this.active.delete(traceId);
      }).catch(() => {});
    }
    return active.stopPromise;
  }

  status(traceId?: string): PerformanceTraceStatus[] {
    if (traceId) this.validateTraceId(traceId);
    const now = Date.now();
    const traces = traceId
      ? [this.active.get(traceId)].filter((entry): entry is ActiveTrace => entry !== undefined)
      : [...this.active.values()];
    return traces
      .map(({ handle }) => {
        const remainingMs = Math.max(0, Date.parse(handle.deadlineAt) - now);
        return {
          ...handle,
          state: remainingMs === 0 ? "ready" as const : "recording" as const,
          remainingMs,
        };
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async deleteArtifact(artifactId: string): Promise<void> {
    await this.artifacts.delete(artifactId);
  }

  private validateTraceId(traceId: string): void {
    if (!TRACE_ID.test(traceId)) {
      throw new ValidationError("traceId must be a UUID returned by performance(action:'trace_start').");
    }
  }
}
