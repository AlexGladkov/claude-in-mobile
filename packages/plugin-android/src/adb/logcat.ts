/**
 * Pure helpers for building `adb logcat` argv and post-filtering its output.
 * Extracted from client.ts (D9.10). Validators are invoked here so the client
 * can stay free of input-format concerns.
 */

import { validateLogTag, validateLogTimestamp } from "mcp-devices/utils/sanitize";

export interface LogcatOptions {
  tag?: string;
  level?: "V" | "D" | "I" | "W" | "E" | "F";
  lines?: number;
  since?: string;
  package?: string;
}

/**
 * Build the argv for `adb shell logcat -d ...` from typed options.
 * Validates `tag` and `since` to keep argv safe.
 */
export function buildLogcatArgs(options: LogcatOptions): string[] {
  const args: string[] = ["shell", "logcat", "-d"];

  if (options.level) {
    args.push(`*:${options.level}`);
  }

  if (options.tag) {
    validateLogTag(options.tag);
    args.push("-s", options.tag);
  }

  if (options.lines) {
    args.push("-t", String(Math.trunc(options.lines)));
  }

  if (options.since) {
    validateLogTimestamp(options.since);
    args.push("-t", options.since);
  }

  return args;
}

/**
 * Node-side filter for logcat output: keep only lines mentioning a package,
 * preserving timestamp lines so the output remains contextual.
 */
export function filterLogsByPackage(output: string, packageName: string): string {
  const lines = output.split("\n");
  const filtered = lines.filter(line =>
    line.includes(packageName) ||
    line.match(/^\d+-\d+\s+\d+:\d+/) // Keep timestamp lines
  );
  return filtered.join("\n");
}
