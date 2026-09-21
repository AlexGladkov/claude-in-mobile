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
  private static readonly MAX_MESSAGE_CHARS = 16 * 1024;
  private entries: Array<LogEntry | undefined>;
  private start = 0;
  private length = 0;

  constructor(private readonly maxEntries: number = 1000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > 2000) {
      throw new Error("Log capacity must be a safe integer between 1 and 2000.");
    }
    this.entries = new Array<LogEntry | undefined>(maxEntries);
  }

  /** Append a bounded log entry, overwriting the oldest entry at capacity. */
  push(type: LogType, message: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      type,
      message: message.slice(-LogRing.MAX_MESSAGE_CHARS),
    };
    if (this.length < this.maxEntries) {
      this.entries[(this.start + this.length) % this.maxEntries] = entry;
      this.length++;
      return;
    }
    this.entries[this.start] = entry;
    this.start = (this.start + 1) % this.maxEntries;
  }

  /** Return a copy of the buffer, optionally filtered by type/since/limit. */
  query(options?: LogOptions): LogEntry[] {
    const result: LogEntry[] = [];
    for (let offset = 0; offset < this.length; offset++) {
      const entry = this.entries[(this.start + offset) % this.maxEntries];
      if (!entry) continue;
      if (options?.type && entry.type !== options.type) continue;
      if (options?.since !== undefined && entry.timestamp < options.since) continue;
      result.push(entry);
    }
    if (options?.limit !== undefined) return result.slice(-options.limit);
    return result;
  }

  /** Drop every buffered entry. */
  clear(): void {
    this.entries = new Array<LogEntry | undefined>(this.maxEntries);
    this.start = 0;
    this.length = 0;
  }
}
