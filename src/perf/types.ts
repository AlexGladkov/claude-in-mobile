/**
 * Performance & Crash Monitor types.
 */

export interface PerfSnapshot {
  platform: string;
  timestamp: string;
  packageName?: string;
  memory: { usedMb: number; totalMb: number } | null;
  cpu: { appPercent: number } | null;
  fps: { current: number; jankyFrames?: number; totalFrames?: number } | null;
  battery: { level: number; temperature?: number; charging: boolean } | null;
  crashes: CrashEntry[];
}

export interface CrashEntry {
  type: "crash" | "anr" | "native_crash";
  timestamp: string;
  process?: string;
  summary: string;
}

export interface PerfBaseline {
  name: string;
  platform: string;
  snapshot: PerfSnapshot;
  createdAt: string;
}

export interface PerfCompareMetric {
  metric: string;
  baselineValue: number;
  currentValue: number;
  diffPercent: number;
  threshold: number;
  status: "PASS" | "FAIL";
}

export interface PerfCompareResult {
  status: "PASS" | "FAIL";
  baselineName: string;
  metrics: PerfCompareMetric[];
}

export interface PerfMonitorResult {
  durationMs: number;
  samples: number;
  memory: { min: number; max: number; avg: number } | null;
  cpu: { min: number; max: number; avg: number } | null;
  fps: { min: number; max: number; avg: number } | null;
  warnings: string[];
}
