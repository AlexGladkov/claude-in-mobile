/**
 * Performance & Crash Monitor tools.
 *
 * Provides 5 tool handlers:
 *   - performance_snapshot: collect current metrics
 *   - performance_baseline: save snapshot as baseline
 *   - performance_compare: compare current vs baseline (PASS/FAIL)
 *   - performance_monitor: continuous monitoring over duration
 *   - performance_crashes: query crash/ANR logs
 */

import type { ToolDefinition } from "./registry.js";
import type { Platform } from "../device-manager.js";
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

const getStore = createLazySingleton(() => new PerfBaselineStore());

// ── Defaults ──

const DEFAULT_THRESHOLDS = { memory: 20, cpu: 30, fps: 10 };
const DEFAULT_MONITOR_DURATION_MS = 5000;
const DEFAULT_MONITOR_INTERVAL_MS = 1000;
const MAX_MONITOR_DURATION_MS = 30000;
const MIN_MONITOR_INTERVAL_MS = 500;

// ── Helpers ──

async function collectSnapshot(
  ctx: Parameters<ToolDefinition["handler"]>[1],
  platform: string,
  packageName?: string,
): Promise<PerfSnapshot> {
  if (platform === "android") {
    const adb = ctx.deviceManager.getAndroidClient();
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

function resolvePlatform(
  argPlatform: string | undefined,
  ctx: Parameters<ToolDefinition["handler"]>[1],
): string {
  return argPlatform ?? ctx.deviceManager.getCurrentPlatform() ?? "android";
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
  {
    tool: {
      name: "performance_snapshot",
      description:
        "Collect current performance metrics: memory, CPU, FPS, battery, crash count. Returns formatted report.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop"],
            description: "Target platform",
          },
          packageName: {
            type: "string",
            description: "App package name (Android). Auto-detected from foreground if not provided.",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = resolvePlatform(args.platform as string | undefined, ctx);
      const packageName = args.packageName as string | undefined;

      const snapshot = await collectSnapshot(ctx, platform, packageName);
      const text = formatSnapshot(snapshot);

      return { text: truncateOutput(text) };
    },
  },

  // 2. baseline
  {
    tool: {
      name: "performance_baseline",
      description:
        "Save current performance metrics as a named baseline for later comparison.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Baseline name (e.g. 'login-flow', 'idle-state')",
          },
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop"],
            description: "Target platform",
          },
          packageName: {
            type: "string",
            description: "App package name (Android). Auto-detected if not provided.",
          },
          overwrite: {
            type: "boolean",
            description: "Overwrite existing baseline (default: false)",
            default: false,
          },
          samples: {
            type: "number",
            description: "Number of samples to average (default: 3, max: 10)",
            default: 3,
          },
        },
        required: ["name"],
      },
    },
    handler: async (args, ctx) => {
      const name = args.name as string;
      if (!name) throw new ValidationError("name is required for baseline");
      validateBaselineName(name, "baseline_name");

      const platform = resolvePlatform(args.platform as string | undefined, ctx);
      const packageName = args.packageName as string | undefined;
      const overwrite = args.overwrite === true;
      const sampleCount = Math.min(Math.max((args.samples as number) ?? 3, 1), 10);

      // Collect multiple samples and average
      const snapshots: PerfSnapshot[] = [];
      for (let i = 0; i < sampleCount; i++) {
        snapshots.push(await collectSnapshot(ctx, platform, packageName));
        if (i < sampleCount - 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      const averaged = averageSnapshots(snapshots);
      const baseline = await getStore().save(name, platform, averaged, overwrite);

      const text = `Performance baseline saved: ${baseline.name} (${baseline.platform})\n${formatSnapshot(baseline.snapshot)}`;
      return { text: truncateOutput(text) };
    },
  },

  // 3. compare
  {
    tool: {
      name: "performance_compare",
      description:
        "Compare current performance against a saved baseline. Returns PASS/FAIL per metric with thresholds.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Baseline name to compare against",
          },
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop"],
            description: "Target platform",
          },
          packageName: {
            type: "string",
            description: "App package name (Android). Auto-detected if not provided.",
          },
          memoryThreshold: {
            type: "number",
            description: "Max allowed memory change % (default: 20)",
            default: 20,
          },
          cpuThreshold: {
            type: "number",
            description: "Max allowed CPU change % (default: 30)",
            default: 30,
          },
          fpsThreshold: {
            type: "number",
            description: "Max allowed FPS drop % (default: 10)",
            default: 10,
          },
        },
        required: ["name"],
      },
    },
    handler: async (args, ctx) => {
      const name = args.name as string;
      if (!name) throw new ValidationError("name is required for compare");
      validateBaselineName(name, "baseline_name");

      const platform = resolvePlatform(args.platform as string | undefined, ctx);
      const packageName = args.packageName as string | undefined;

      const thresholds = {
        memory: (args.memoryThreshold as number) ?? DEFAULT_THRESHOLDS.memory,
        cpu: (args.cpuThreshold as number) ?? DEFAULT_THRESHOLDS.cpu,
        fps: (args.fpsThreshold as number) ?? DEFAULT_THRESHOLDS.fps,
      };

      const baseline = await getStore().get(name, platform);
      const current = await collectSnapshot(ctx, platform, packageName);

      const metrics = buildCompareMetrics(baseline.snapshot, current, thresholds);
      const hasFail = metrics.some((m) => m.status === "FAIL");

      const result: PerfCompareResult = {
        status: hasFail ? "FAIL" : "PASS",
        baselineName: `${name} (${platform})`,
        metrics,
      };

      const text = formatCompare(result);

      return {
        text: truncateOutput(text),
        ...(hasFail ? { isError: true } : {}),
      };
    },
  },

  // 4. monitor
  {
    tool: {
      name: "performance_monitor",
      description:
        "Monitor performance over a duration, collecting periodic samples. Returns min/max/avg stats.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop"],
            description: "Target platform",
          },
          packageName: {
            type: "string",
            description: "App package name (Android). Auto-detected if not provided.",
          },
          duration: {
            type: "number",
            description: "Monitoring duration in ms (default: 5000, max: 30000)",
            default: 5000,
          },
          interval: {
            type: "number",
            description: "Sampling interval in ms (default: 1000, min: 500)",
            default: 1000,
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = resolvePlatform(args.platform as string | undefined, ctx);
      const packageName = args.packageName as string | undefined;

      const duration = Math.min(
        Math.max((args.duration as number) ?? DEFAULT_MONITOR_DURATION_MS, MIN_MONITOR_INTERVAL_MS),
        MAX_MONITOR_DURATION_MS,
      );
      const interval = Math.max(
        (args.interval as number) ?? DEFAULT_MONITOR_INTERVAL_MS,
        MIN_MONITOR_INTERVAL_MS,
      );

      const snapshots: PerfSnapshot[] = [];
      const warnings: string[] = [];
      const startTime = Date.now();

      while (Date.now() - startTime < duration) {
        try {
          snapshots.push(await collectSnapshot(ctx, platform, packageName));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          warnings.push(`Sample failed: ${msg.slice(0, 100)}`);
        }

        const elapsed = Date.now() - startTime;
        if (elapsed + interval < duration) {
          await new Promise((r) => setTimeout(r, interval));
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

      return { text: truncateOutput(text) };
    },
  },

  // 5. crashes
  {
    tool: {
      name: "performance_crashes",
      description:
        "Query recent crashes, ANRs, and native crashes from device logs.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            enum: ["android", "ios", "desktop"],
            description: "Target platform",
          },
          packageName: {
            type: "string",
            description: "App package name (Android). Auto-detected if not provided.",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      const platform = resolvePlatform(args.platform as string | undefined, ctx);
      const packageName = args.packageName as string | undefined;

      const snapshot = await collectSnapshot(ctx, platform, packageName);
      const text = formatCrashes(snapshot.crashes, platform);
      const hasCrashes = snapshot.crashes.length > 0;

      return {
        text: truncateOutput(text),
        ...(hasCrashes ? { isError: true } : {}),
      };
    },
  },
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
