/**
 * Performance & Crash Monitor tools.
 *
 * Provides 6 tool handlers:
 *   - performance_snapshot: collect current metrics
 *   - performance_baseline: save snapshot as baseline
 *   - performance_compare: compare current vs baseline (PASS/FAIL)
 *   - performance_monitor: continuous monitoring over duration
 *   - performance_crashes: query crash/ANR logs
 *   - performance_framestats: collect GPU frame rendering statistics (Android only)
 */

import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import type { PerfSnapshot, PerfCompareMetric, PerfCompareResult, PerfMonitorResult } from "../perf/types.js";
import {
  collectAndroidSnapshot,
  collectDesktopSnapshot,
  collectIosSnapshot,
  detectForegroundPackage,
} from "../perf/collector.js";
import {
  formatSnapshot,
  formatCompare,
  formatMonitor,
  formatCrashes,
} from "../perf/formatter.js";
import { PerfBaselineStore } from "../utils/perf-baseline-store.js";
import { createLazySingleton } from "../utils/lazy.js";
import { truncateOutput } from "../utils/truncate.js";
import { ValidationError, PerfCollectionError } from "../errors.js";
import { validatePackageName, validateBaselineName } from "../utils/sanitize.js";
import { defineTool, z } from "./define-tool.js";
import { parseCommonArgs } from "../utils/parse-common-args.js";
import { textResult, errorResult } from "../utils/tool-result.js";
import { sleep } from "../utils/sleep.js";
import { PERFORMANCE } from "../constants/timeouts.js";

const getStore = createLazySingleton(() => new PerfBaselineStore());

// ── Defaults ──

const DEFAULT_THRESHOLDS = { memory: 20, cpu: 30, fps: 10 };
const DEFAULT_MONITOR_DURATION_MS = 5000;
const DEFAULT_MONITOR_INTERVAL_MS = 1000;
const MAX_MONITOR_DURATION_MS = PERFORMANCE.MAX_MONITOR_DURATION_MS;
const MIN_MONITOR_INTERVAL_MS = PERFORMANCE.POLL_INTERVAL_MS;

// Shared zod fragments
const platformEnum = z
  .enum(["android", "ios", "desktop", "aurora", "browser"])
  .optional()
  .describe("Target platform");
const deviceIdField = z
  .string()
  .optional()
  .describe("Target device ID for multi-device. If omitted, uses active device.");

// ── Helpers ──

async function collectSnapshot(
  ctx: ToolContext,
  platform: string,
  packageName?: string,
  deviceId?: string,
): Promise<PerfSnapshot> {
  if (platform === "android") {
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
  }

  if (platform === "desktop") {
    const desktop = ctx.deviceManager.getDesktopClient();
    return collectDesktopSnapshot(desktop);
  }

  if (platform === "ios") {
    return collectIosSnapshot();
  }

  throw new ValidationError(`Performance collection is not supported for platform "${platform}". Supported: android, desktop, ios.`);
}

function buildCompareMetrics(
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

// ── Tool definitions ──

export const performanceTools: ToolDefinition[] = [
  // 1. snapshot
  defineTool({
    name: "performance_snapshot",
    description:
      "Collect current performance metrics: memory, CPU, FPS, battery, crash count. Returns formatted report.",
    schema: z.object({
      platform: platformEnum,
      packageName: z
        .string()
        .optional()
        .describe("App package name (Android). Auto-detected from foreground if not provided."),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const packageName = args.packageName;

      const snapshot = await collectSnapshot(ctx, platform, packageName, deviceId);
      const text = formatSnapshot(snapshot);

      return textResult(truncateOutput(text));
    },
  }),

  // 2. baseline
  defineTool({
    name: "performance_baseline",
    description:
      "Save current performance metrics as a named baseline for later comparison.",
    schema: z.object({
      name: z
        .string({ error: "name is required for baseline" })
        .min(1, "name is required for baseline")
        .describe("Baseline name (e.g. 'login-flow', 'idle-state')"),
      platform: platformEnum,
      packageName: z
        .string()
        .optional()
        .describe("App package name (Android). Auto-detected if not provided."),
      overwrite: z
        .boolean()
        .optional()
        .describe("Overwrite existing baseline (default: false)"),
      samples: z
        .number()
        .optional()
        .describe("Number of samples to average (default: 3, max: 10)"),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const name = args.name;
      validateBaselineName(name, "baseline_name");

      const packageName = args.packageName;
      const overwrite = args.overwrite === true;
      const sampleCount = Math.min(Math.max(args.samples ?? 3, 1), 10);

      // Collect multiple samples and average
      const snapshots: PerfSnapshot[] = [];
      for (let i = 0; i < sampleCount; i++) {
        snapshots.push(await collectSnapshot(ctx, platform, packageName, deviceId));
        if (i < sampleCount - 1) {
          await sleep(500);
        }
      }

      const averaged = averageSnapshots(snapshots);
      const baseline = await getStore().save(name, platform, averaged, overwrite);

      const text = `Performance baseline saved: ${baseline.name} (${baseline.platform})\n${formatSnapshot(baseline.snapshot)}`;
      return textResult(truncateOutput(text));
    },
  }),

  // 3. compare
  defineTool({
    name: "performance_compare",
    description:
      "Compare current performance against a saved baseline. Returns PASS/FAIL per metric with thresholds.",
    schema: z.object({
      name: z
        .string({ error: "name is required for compare" })
        .min(1, "name is required for compare")
        .describe("Baseline name to compare against"),
      platform: platformEnum,
      packageName: z
        .string()
        .optional()
        .describe("App package name (Android). Auto-detected if not provided."),
      memoryThreshold: z
        .number()
        .optional()
        .describe("Max allowed memory change % (default: 20)"),
      cpuThreshold: z
        .number()
        .optional()
        .describe("Max allowed CPU change % (default: 30)"),
      fpsThreshold: z
        .number()
        .optional()
        .describe("Max allowed FPS drop % (default: 10)"),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const name = args.name;
      validateBaselineName(name, "baseline_name");

      const packageName = args.packageName;

      const thresholds = {
        memory: args.memoryThreshold ?? DEFAULT_THRESHOLDS.memory,
        cpu: args.cpuThreshold ?? DEFAULT_THRESHOLDS.cpu,
        fps: args.fpsThreshold ?? DEFAULT_THRESHOLDS.fps,
      };

      const baseline = await getStore().get(name, platform);
      const current = await collectSnapshot(ctx, platform, packageName, deviceId);

      const metrics = buildCompareMetrics(baseline.snapshot, current, thresholds);
      const hasFail = metrics.some((m) => m.status === "FAIL");

      const result: PerfCompareResult = {
        status: hasFail ? "FAIL" : "PASS",
        baselineName: `${name} (${platform})`,
        metrics,
      };

      const text = truncateOutput(formatCompare(result));
      return hasFail ? errorResult(text) : textResult(text);
    },
  }),

  // 4. monitor
  defineTool({
    name: "performance_monitor",
    description:
      "Monitor performance over a duration, collecting periodic samples. Returns min/max/avg stats.",
    schema: z.object({
      platform: platformEnum,
      packageName: z
        .string()
        .optional()
        .describe("App package name (Android). Auto-detected if not provided."),
      duration: z
        .number()
        .optional()
        .describe("Monitoring duration in ms (default: 5000, max: 30000)"),
      interval: z
        .number()
        .optional()
        .describe("Sampling interval in ms (default: 1000, min: 500)"),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const packageName = args.packageName;

      const duration = Math.min(
        Math.max(args.duration ?? DEFAULT_MONITOR_DURATION_MS, MIN_MONITOR_INTERVAL_MS),
        MAX_MONITOR_DURATION_MS,
      );
      const interval = Math.max(args.interval ?? DEFAULT_MONITOR_INTERVAL_MS, MIN_MONITOR_INTERVAL_MS);

      const snapshots: PerfSnapshot[] = [];
      const warnings: string[] = [];
      const startTime = Date.now();

      while (Date.now() - startTime < duration) {
        try {
          snapshots.push(await collectSnapshot(ctx, platform, packageName, deviceId));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          warnings.push(`Sample failed: ${msg.slice(0, 100)}`);
        }

        const elapsed = Date.now() - startTime;
        if (elapsed + interval < duration) {
          await sleep(interval);
        } else {
          break;
        }
      }

      const actualDuration = Date.now() - startTime;

      if (snapshots.length === 0) {
        throw new PerfCollectionError(platform, "No samples collected during monitoring period.");
      }

      const result = aggregateSnapshots(snapshots, actualDuration, warnings);
      const text = formatMonitor(result, platform);

      return textResult(truncateOutput(text));
    },
  }),

  // 5. crashes
  defineTool({
    name: "performance_crashes",
    description: "Query recent crashes, ANRs, and native crashes from device logs.",
    schema: z.object({
      platform: platformEnum,
      packageName: z
        .string()
        .optional()
        .describe("App package name (Android). Auto-detected if not provided."),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
      const packageName = args.packageName;

      const snapshot = await collectSnapshot(ctx, platform, packageName, deviceId);
      const text = truncateOutput(formatCrashes(snapshot.crashes, platform));
      const hasCrashes = snapshot.crashes.length > 0;

      return hasCrashes ? errorResult(text) : textResult(text);
    },
  }),

  // 6. framestats
  defineTool({
    name: "performance_framestats",
    description:
      "Collect frame rendering statistics from GPU profiling. Returns frame time percentiles (p50/p90/p99), jank rate, and slow render percentage. Android only.",
    schema: z.object({
      platform: platformEnum,
      packageName: z
        .string()
        .optional()
        .describe("App package name. Auto-detected from foreground if not provided."),
      deviceId: deviceIdField,
    }),
    handler: async (args, ctx) => {
      const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);

      if (platform !== "android") {
        throw new ValidationError(
          `performance_framestats is Android-only. Current platform: "${platform}".`,
        );
      }

      const adb = ctx.deviceManager.getAndroidClient(deviceId);
      let pkg = args.packageName;
      if (!pkg) {
        pkg = detectForegroundPackage(adb);
      }
      if (!pkg) {
        throw new PerfCollectionError(
          "android",
          "Could not detect foreground package. Provide packageName explicitly.",
        );
      }
      validatePackageName(pkg);

      // Reset gfxinfo stats
      adb.exec(`shell dumpsys gfxinfo ${pkg} reset`);
      await sleep(100);

      // Collect framestats
      const rawOutput: string = adb.exec(`shell dumpsys gfxinfo ${pkg} framestats`);

      const stats = parseFrameStats(rawOutput);
      const text = formatFrameStats(stats, pkg);

      return textResult(truncateOutput(text));
    },
  }),
];

// ── Aggregation helpers ──

function averageSnapshots(snapshots: PerfSnapshot[]): PerfSnapshot {
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

function aggregateSnapshots(
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

interface FrameStats {
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

function parseFrameStats(output: string): FrameStats {
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

function formatFrameStats(stats: FrameStats, packageName: string): string {
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
