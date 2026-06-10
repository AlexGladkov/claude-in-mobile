/**
 * Bounded in-memory ring buffer for desktop companion log entries.
 *
 * Keeps the most recent `maxEntries` lines and supports filtered queries by
 * level, since-timestamp and limit. Once the buffer is full the oldest entry
 * is dropped on every push (FIFO eviction), so the memory footprint of a
 * long-running session stays bounded.
 */

import type { LogEntry, LogOptions, LogType } from "./types.js";

export class LogRing {
  private entries: LogEntry[] = [];

  constructor(private readonly maxEntries: number = 10_000) {}

  /** Append a new log line. Evicts the oldest entry once the buffer is full. */
  push(type: LogType, message: string): void {
    this.entries.push({
      timestamp: Date.now(),
      type,
      message,
    });

    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /** Return a copy of the buffer, optionally filtered by type/since/limit. */
  query(options?: LogOptions): LogEntry[] {
    let result = [...this.entries];

    if (options?.type) {
      result = result.filter(log => log.type === options.type);
    }

    if (options?.since) {
      result = result.filter(log => log.timestamp >= options.since!);
    }

    if (options?.limit) {
      result = result.slice(-options.limit);
    }

    return result;
  }

  /** Drop every buffered entry. */
  clear(): void {
    this.entries = [];
  }
}
