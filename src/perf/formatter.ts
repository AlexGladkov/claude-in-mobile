/**
 * Performance metric formatting for LLM output.
 * Follows PASS/FAIL pattern from visual-tools.
 */

import type {
  PerfSnapshot,
  PerfCompareResult,
  PerfMonitorResult,
  CrashEntry,
} from "./types.js";

/**
 * Format a performance snapshot as human-readable text.
 */
export function formatSnapshot(snapshot: PerfSnapshot): string {
  const pkg = snapshot.packageName ? `, ${snapshot.packageName}` : "";
  const lines: string[] = [`Performance snapshot (${snapshot.platform}${pkg})`];

  if (snapshot.memory) {
    const total = snapshot.memory.totalMb > 0 ? ` / ${snapshot.memory.totalMb} MB total` : "";
    lines.push(`  Memory: ${snapshot.memory.usedMb} MB used${total}`);
  } else {
    lines.push("  Memory: N/A");
  }

  if (snapshot.cpu) {
    lines.push(`  CPU: ${snapshot.cpu.appPercent}% (app)`);
  } else {
    lines.push("  CPU: N/A");
  }

  if (snapshot.fps) {
    const janky =
      snapshot.fps.jankyFrames !== undefined && snapshot.fps.totalFrames !== undefined
        ? ` (${snapshot.fps.jankyFrames} janky / ${snapshot.fps.totalFrames} total)`
        : "";
    lines.push(`  FPS: ${snapshot.fps.current}${janky}`);
  } else {
    lines.push("  FPS: N/A");
  }

  if (snapshot.battery) {
    const temp = snapshot.battery.temperature !== undefined
      ? `, ${snapshot.battery.temperature}\u00B0C`
      : "";
    const charging = snapshot.battery.charging ? ", charging" : "";
    lines.push(`  Battery: ${snapshot.battery.level}%${temp}${charging}`);
  } else {
    lines.push("  Battery: N/A");
  }

  lines.push(`  Crashes: ${snapshot.crashes.length}`);

  return lines.join("\n");
}

/**
 * Format a performance comparison result with PASS/FAIL.
 */
export function formatCompare(result: PerfCompareResult): string {
  const failedCount = result.metrics.filter((m) => m.status === "FAIL").length;
  const header =
    result.status === "PASS"
      ? `PERF PASS: ${result.baselineName}`
      : `PERF FAIL: ${result.baselineName} \u2014 ${failedCount} metric${failedCount !== 1 ? "s" : ""} exceeded threshold`;

  const metricLines = result.metrics.map((m) => {
    const sign = m.diffPercent >= 0 ? "+" : "";
    return `  ${m.metric}: ${formatMetricValue(m.metric, m.baselineValue)} \u2192 ${formatMetricValue(m.metric, m.currentValue)} (${sign}${m.diffPercent.toFixed(1)}%, threshold: ${m.threshold}%) ${m.status}`;
  });

  return [header, ...metricLines].join("\n");
}

/**
 * Format a performance monitor result.
 */
export function formatMonitor(result: PerfMonitorResult, platform: string): string {
  const lines: string[] = [
    `Performance monitor (${platform}) \u2014 ${result.durationMs}ms, ${result.samples} samples`,
  ];

  if (result.memory) {
    lines.push(
      `  Memory: min ${result.memory.min} MB, max ${result.memory.max} MB, avg ${result.memory.avg} MB`,
    );
  }

  if (result.cpu) {
    lines.push(
      `  CPU: min ${result.cpu.min}%, max ${result.cpu.max}%, avg ${result.cpu.avg}%`,
    );
  }

  if (result.fps) {
    lines.push(
      `  FPS: min ${result.fps.min}, max ${result.fps.max}, avg ${result.fps.avg}`,
    );
  }

  if (result.warnings.length > 0) {
    lines.push("");
    for (const w of result.warnings) {
      lines.push(`  \u26A0 ${w}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format crash entries.
 */
export function formatCrashes(crashes: CrashEntry[], platform: string, since?: string): string {
  if (crashes.length === 0) {
    const sinceText = since ? ` since ${since}` : "";
    return `0 crashes detected (${platform})${sinceText}`;
  }

  const sinceText = since ? ` since ${since}` : "";
  const lines: string[] = [
    `${crashes.length} crash${crashes.length !== 1 ? "es" : ""} detected (${platform})${sinceText}`,
  ];

  for (const c of crashes) {
    const tag = c.type === "anr" ? "ANR" : c.type === "native_crash" ? "NATIVE" : "CRASH";
    const proc = c.process ? ` (${c.process})` : "";
    lines.push(`  [${tag}] ${c.timestamp}${proc} \u2014 ${c.summary}`);
  }

  return lines.join("\n");
}

// ── Helpers ──

function formatMetricValue(metric: string, value: number): string {
  switch (metric) {
    case "memory":
      return `${value} MB`;
    case "cpu":
      return `${value}%`;
    case "fps":
      return `${value}`;
    default:
      return `${value}`;
  }
}
