import type { ToolContext } from "../context.js";
import type { PerfSnapshot, PerfCompareMetric, PerfMonitorResult } from "../../perf/types.js";
import {
  collectAndroidSnapshot,
  collectDesktopSnapshot,
  collectIosSnapshot,
  detectForegroundPackage,
} from "../../perf/collector.js";
import { PerfBaselineStore } from "../../utils/perf-baseline-store.js";
import { createLazySingleton } from "../../utils/lazy.js";
import { ValidationError, PerfCollectionError } from "../../errors.js";
import { validatePackageName } from "../../utils/sanitize.js";
import { platformEnum as basePlatformEnum, deviceIdField as baseDeviceIdField } from "../common-schema.js";
import { PERFORMANCE } from "../../constants/timeouts.js";
import { dispatchByPlatform } from "../helpers/dispatch.js";

export const getStore = createLazySingleton(() => new PerfBaselineStore());

// ── Defaults ──

export const DEFAULT_THRESHOLDS = { memory: 20, cpu: 30, fps: 10 };
export const DEFAULT_MONITOR_DURATION_MS = 5000;
export const DEFAULT_MONITOR_INTERVAL_MS = 1000;
export const MAX_MONITOR_DURATION_MS = PERFORMANCE.MAX_MONITOR_DURATION_MS;
export const MIN_MONITOR_INTERVAL_MS = PERFORMANCE.POLL_INTERVAL_MS;

// Re-exported shared zod fragments (centralised in tools/common-schema.ts).
export const platformEnum = basePlatformEnum;
export const deviceIdField = baseDeviceIdField;

// ── Helpers ──

export async function collectSnapshot(
  ctx: ToolContext,
  platform: string,
  packageName?: string,
  deviceId?: string,
): Promise<PerfSnapshot> {
  return Promise.resolve(
    dispatchByPlatform<PerfSnapshot>(platform, {
      android: () => {
        const adb = ctx.deviceManager.getAndroidClient(deviceId);
        let pkg = packageName;
        if (!pkg) {
          pkg = detectForegroundPackage(adb);
        }
        if (!pkg) {
          throw new PerfCollectionError("android", "Could not detect foreground package. Provide packageName explicitly.");
        }
        validatePackageName(pkg);
        return collectAndroidSnapshot(adb, pkg);
      },
      desktop: () => {
        const desktop = ctx.deviceManager.getDesktopClient();
        return collectDesktopSnapshot(desktop);
      },
      ios: () => collectIosSnapshot(),
      unsupported: (p) => {
        throw new ValidationError(`Performance collection is not supported for platform "${p}". Supported: android, desktop, ios.`);
      },
    }),
  );
}

export function buildCompareMetrics(
  baseline: PerfSnapshot,
  current: PerfSnapshot,
  thresholds: { memory: number; cpu: number; fps: number },
): PerfCompareMetric[] {
  const metrics: PerfCompareMetric[] = [];

  if (baseline.memory && current.memory) {
    const bv = baseline.memory.usedMb;
    const cv = current.memory.usedMb;
    const diff = bv === 0 ? 0 : ((cv - bv) / bv) * 100;
    metrics.push({
      metric: "memory",
      baselineValue: bv,
      currentValue: cv,
      diffPercent: Math.round(diff * 10) / 10,
      threshold: thresholds.memory,
      status: Math.abs(diff) <= thresholds.memory ? "PASS" : "FAIL",
    });
  }

  if (baseline.cpu && current.cpu) {
    const bv = baseline.cpu.appPercent;
    const cv = current.cpu.appPercent;
    const diff = bv === 0 ? 0 : ((cv - bv) / bv) * 100;
    metrics.push({
      metric: "cpu",
      baselineValue: bv,
      currentValue: cv,
      diffPercent: Math.round(diff * 10) / 10,
      threshold: thresholds.cpu,
      status: Math.abs(diff) <= thresholds.cpu ? "PASS" : "FAIL",
    });
  }

  if (baseline.fps && current.fps) {
    const bv = baseline.fps.current;
    const cv = current.fps.current;
    const diff = bv === 0 ? 0 : ((cv - bv) / bv) * 100;
    metrics.push({
      metric: "fps",
      baselineValue: bv,
      currentValue: cv,
      diffPercent: Math.round(diff * 10) / 10,
      threshold: thresholds.fps,
      // For FPS, decrease is bad (negative diff), increase is fine
      status: diff >= -thresholds.fps ? "PASS" : "FAIL",
    });
  }

  return metrics;
}

// ── Aggregation helpers ──

export function averageSnapshots(snapshots: PerfSnapshot[]): PerfSnapshot {
  if (snapshots.length === 0) throw new Error("No snapshots to average");
  if (snapshots.length === 1) return snapshots[0];

  const base = snapshots[0];
  const memoryValues = snapshots.map((s) => s.memory?.usedMb).filter((v): v is number => v !== undefined);
  const cpuValues = snapshots.map((s) => s.cpu?.appPercent).filter((v): v is number => v !== undefined);
  const fpsValues = snapshots.map((s) => s.fps?.current).filter((v): v is number => v !== undefined);

  return {
    ...base,
    memory: memoryValues.length > 0
      ? { usedMb: round(avg(memoryValues)), totalMb: base.memory?.totalMb ?? 0 }
      : base.memory,
    cpu: cpuValues.length > 0
      ? { appPercent: round(avg(cpuValues)) }
      : base.cpu,
    fps: fpsValues.length > 0
      ? { current: Math.round(avg(fpsValues)), jankyFrames: base.fps?.jankyFrames, totalFrames: base.fps?.totalFrames }
      : base.fps,
    // Keep crashes from last snapshot only (deduplicate)
    crashes: base.crashes,
  };
}

export function aggregateSnapshots(
  snapshots: PerfSnapshot[],
  durationMs: number,
  warnings: string[],
): PerfMonitorResult {
  const memoryValues = snapshots.map((s) => s.memory?.usedMb).filter((v): v is number => v !== undefined);
  const cpuValues = snapshots.map((s) => s.cpu?.appPercent).filter((v): v is number => v !== undefined);
  const fpsValues = snapshots.map((s) => s.fps?.current).filter((v): v is number => v !== undefined);

  return {
    durationMs,
    samples: snapshots.length,
    memory: memoryValues.length > 0
      ? { min: round(Math.min(...memoryValues)), max: round(Math.max(...memoryValues)), avg: round(avg(memoryValues)) }
      : null,
    cpu: cpuValues.length > 0
      ? { min: round(Math.min(...cpuValues)), max: round(Math.max(...cpuValues)), avg: round(avg(cpuValues)) }
      : null,
    fps: fpsValues.length > 0
      ? { min: Math.min(...fpsValues), max: Math.max(...fpsValues), avg: round(avg(fpsValues)) }
      : null,
    warnings,
  };
}

function avg(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

// ── Framestats helpers ──

export interface FrameStats {
  totalFrames: number;
  jankyFrames: number;
  jankyPercent: number;
  percentiles: { p50: number; p90: number; p95: number; p99: number };
  causes: {
    missedVsync: number;
    highInputLatency: number;
    slowUiThread: number;
    slowBitmapUploads: number;
    slowIssueDraw: number;
    frameDeadlineMissed: number;
  };
}

function computePercentiles(
  frameTimes: number[],
): { p50: number; p90: number; p95: number; p99: number } {
  if (frameTimes.length === 0) {
    return { p50: 0, p90: 0, p95: 0, p99: 0 };
  }
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const at = (pct: number): number => {
    const idx = Math.min(Math.floor((pct / 100) * sorted.length), sorted.length - 1);
    return Math.round(sorted[idx] * 10) / 10;
  };
  return { p50: at(50), p90: at(90), p95: at(95), p99: at(99) };
}

export function parseFrameStats(output: string): FrameStats {
  // Default zero values
  let totalFrames = 0;
  let jankyFrames = 0;
  let jankyPercent = 0;
  let missedVsync = 0;
  let highInputLatency = 0;
  let slowUiThread = 0;
  let slowBitmapUploads = 0;
  let slowIssueDraw = 0;
  let frameDeadlineMissed = 0;

  // Parse summary fields
  const totalMatch = output.match(/Total frames rendered:\s*(\d+)/);
  if (totalMatch) totalFrames = parseInt(totalMatch[1], 10);

  const jankyMatch = output.match(/Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/);
  if (jankyMatch) {
    jankyFrames = parseInt(jankyMatch[1], 10);
    jankyPercent = parseFloat(jankyMatch[2]);
  }

  const missedVsyncMatch = output.match(/Number Missed Vsync:\s*(\d+)/);
  if (missedVsyncMatch) missedVsync = parseInt(missedVsyncMatch[1], 10);

  const highInputMatch = output.match(/Number High input latency:\s*(\d+)/);
  if (highInputMatch) highInputLatency = parseInt(highInputMatch[1], 10);

  const slowUiMatch = output.match(/Number Slow UI thread:\s*(\d+)/);
  if (slowUiMatch) slowUiThread = parseInt(slowUiMatch[1], 10);

  const slowBitmapMatch = output.match(/Number Slow bitmap uploads:\s*(\d+)/);
  if (slowBitmapMatch) slowBitmapUploads = parseInt(slowBitmapMatch[1], 10);

  const slowIssueMatch = output.match(/Number Slow issue draw commands:\s*(\d+)/);
  if (slowIssueMatch) slowIssueDraw = parseInt(slowIssueMatch[1], 10);

  const deadlineMatch = output.match(/Number Frame deadline missed:\s*(\d+)/);
  if (deadlineMatch) frameDeadlineMissed = parseInt(deadlineMatch[1], 10);

  // Attempt to parse raw per-frame nanosecond data for accurate percentiles.
  // Format per line: FLAGS,INTENDED_VSYNC,VSYNC,...,FRAME_COMPLETED,GPU_COMPLETED
  // Valid frames have FLAGS != 0x1 (skip FLAG=1 which marks skip/invalid frames).
  const frameTimes: number[] = [];

  // Raw framestats block: lines of comma-separated values where first field is FLAGS
  // and the line has at least 14 comma-separated numeric fields (nanoseconds).
  const rawLineRe = /^(\d+),(\d+),\d+(?:,\d+){10,},(\d+),(\d+)$/gm;
  let rawMatch: RegExpExecArray | null;
  while ((rawMatch = rawLineRe.exec(output)) !== null) {
    const flags = parseInt(rawMatch[1], 10);
    if (flags === 1) continue; // skip/invalid frame marker

    const intendedVsync = parseInt(rawMatch[2], 10);
    // FRAME_COMPLETED is second-to-last captured group (index 3)
    const frameCompleted = parseInt(rawMatch[3], 10);
    const frameTimeMs = (frameCompleted - intendedVsync) / 1_000_000;
    if (frameTimeMs > 0 && frameTimeMs < 10_000) {
      frameTimes.push(frameTimeMs);
    }
  }

  let percentiles: { p50: number; p90: number; p95: number; p99: number };

  if (frameTimes.length >= 2) {
    // Use raw per-frame data when available
    percentiles = computePercentiles(frameTimes);
    if (totalFrames === 0) totalFrames = frameTimes.length;
  } else {
    // Fall back to HISTOGRAM section: "5ms=100 6ms=80 ..."
    const histogramMatch = output.match(/HISTOGRAM:\s*(.+)/);
    if (histogramMatch) {
      const expandedTimes: number[] = [];
      const entries = histogramMatch[1].trim().split(/\s+/);
      for (const entry of entries) {
        const entryMatch = entry.match(/^(\d+)ms=(\d+)$/);
        if (entryMatch) {
          const ms = parseInt(entryMatch[1], 10);
          const count = parseInt(entryMatch[2], 10);
          for (let i = 0; i < count; i++) expandedTimes.push(ms);
        }
      }
      percentiles = computePercentiles(expandedTimes);
      if (totalFrames === 0) totalFrames = expandedTimes.length;
    } else {
      percentiles = { p50: 0, p90: 0, p95: 0, p99: 0 };
    }
  }

  return {
    totalFrames,
    jankyFrames,
    jankyPercent,
    percentiles,
    causes: {
      missedVsync,
      highInputLatency,
      slowUiThread,
      slowBitmapUploads,
      slowIssueDraw,
      frameDeadlineMissed,
    },
  };
}

export function formatFrameStats(stats: FrameStats, packageName: string): string {
  const sep = "━".repeat(28);
  const lines: string[] = [
    `Frame Statistics: ${packageName}`,
    sep,
    `Total frames: ${stats.totalFrames}`,
    `Janky frames: ${stats.jankyFrames} (${stats.jankyPercent.toFixed(1)}%)`,
    sep,
    "Frame time percentiles:",
    `  p50: ${stats.percentiles.p50}ms`,
    `  p90: ${stats.percentiles.p90}ms`,
    `  p95: ${stats.percentiles.p95}ms`,
    `  p99: ${stats.percentiles.p99}ms`,
    sep,
    "Jank causes:",
    `  Missed Vsync: ${stats.causes.missedVsync}`,
    `  High input latency: ${stats.causes.highInputLatency}`,
    `  Slow UI thread: ${stats.causes.slowUiThread}`,
    `  Slow bitmap uploads: ${stats.causes.slowBitmapUploads}`,
    `  Slow issue draw: ${stats.causes.slowIssueDraw}`,
    `  Frame deadline missed: ${stats.causes.frameDeadlineMissed}`,
  ];
  return lines.join("\n");
}
