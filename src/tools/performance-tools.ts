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
import { performanceSnapshot } from "./performance/snapshot.js";
import { performanceBaseline } from "./performance/baseline.js";
import { performanceCompare } from "./performance/compare.js";
import { performanceMonitor } from "./performance/monitor.js";
import { performanceCrashes } from "./performance/crashes.js";
import { performanceFramestats } from "./performance/framestats.js";

export const performanceTools: ToolDefinition[] = [
  performanceSnapshot,
  performanceBaseline,
  performanceCompare,
  performanceMonitor,
  performanceCrashes,
  performanceFramestats,
];
