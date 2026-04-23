export interface ToolMetric {
  calls: number;
  errors: number;
  totalMs: number;
  lastCallAt: number;
}

export class ToolMetricsCollector {
  private metrics = new Map<string, ToolMetric>();

  record(toolName: string, durationMs: number, isError: boolean): void {
    const existing = this.metrics.get(toolName) ?? { calls: 0, errors: 0, totalMs: 0, lastCallAt: 0 };
    existing.calls++;
    if (isError) existing.errors++;
    existing.totalMs += durationMs;
    existing.lastCallAt = Date.now();
    this.metrics.set(toolName, existing);
  }

  getSummary(): Record<string, ToolMetric> {
    const result: Record<string, ToolMetric> = {};
    for (const [name, metric] of this.metrics) {
      result[name] = { ...metric };
    }
    return result;
  }

  getFormatted(): string {
    if (this.metrics.size === 0) return "No tool calls recorded.";

    const lines: string[] = ["Tool metrics:"];
    const sorted = [...this.metrics.entries()].sort((a, b) => b[1].calls - a[1].calls);

    for (const [name, m] of sorted) {
      const avgMs = m.calls > 0 ? Math.round(m.totalMs / m.calls) : 0;
      const errorRate = m.calls > 0 ? Math.round((m.errors / m.calls) * 100) : 0;
      lines.push(`  ${name}: ${m.calls} calls, avg ${avgMs}ms, errors ${m.errors} (${errorRate}%)`);
    }

    const totalCalls = [...this.metrics.values()].reduce((s, m) => s + m.calls, 0);
    const totalErrors = [...this.metrics.values()].reduce((s, m) => s + m.errors, 0);
    lines.push(`\nTotal: ${totalCalls} calls, ${totalErrors} errors`);

    return lines.join("\n");
  }

  reset(): void {
    this.metrics.clear();
  }
}

// Global singleton
let globalMetrics: ToolMetricsCollector | null = null;

export function getGlobalMetrics(): ToolMetricsCollector {
  if (!globalMetrics) globalMetrics = new ToolMetricsCollector();
  return globalMetrics;
}
