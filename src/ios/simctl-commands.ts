/**
 * Pure simctl argv builders. No I/O.
 *
 * SECURITY: All builders return string[] for execFileSync — no shell parsing.
 * Predicate strings and paths travel as distinct argv slots.
 */

export interface LogShowOptions {
  predicate?: string;
  level?: "debug" | "info" | "default" | "error" | "fault";
}

/**
 * Build argv for `simctl spawn <device> log show ...`.
 */
export function buildLogShowArgs(
  device: string,
  lastWindow: string,
  options: LogShowOptions = {},
): string[] {
  const args: string[] = [
    "spawn", device, "log", "show", "--style", "compact", "--last", lastWindow,
  ];
  if (options.level) {
    args.push("--predicate", `messageType == ${options.level}`);
  }
  if (options.predicate) {
    args.push("--predicate", options.predicate);
  }
  return args;
}

/**
 * Build argv for app-scoped log query (predicate = subsystem == "<bundleId>").
 * Caller must validate bundleId BEFORE calling this builder.
 */
export function buildAppLogArgs(device: string, bundleId: string, lastWindow: string = "5m"): string[] {
  return [
    "spawn", device, "log", "show", "--style", "compact",
    "--last", lastWindow,
    "--predicate", `subsystem == "${bundleId}"`,
  ];
}

/**
 * Split a whitespace-separated command into argv tokens.
 * Safe only for commands without quoted strings / spaces inside args.
 */
export function splitArgs(command: string): string[] {
  return command.split(/\s+/).filter(Boolean);
}

/**
 * Slice the last `n` lines from a newline-delimited string.
 * Node-side replacement for `| tail -n` (no shell needed).
 */
export function sliceLastLines(text: string, n: number): string {
  const linesN = Math.trunc(Math.max(0, n));
  return text.split("\n").slice(-linesN).join("\n");
}

/**
 * Coerce a lat/lon pair into finite numbers; throw on NaN/Infinity.
 * Returns the canonical `lat,lon` argument string expected by `simctl location set`.
 */
export function formatLatLon(lat: number, lon: number): string {
  const latN = Number(lat);
  const lonN = Number(lon);
  if (!Number.isFinite(latN) || !Number.isFinite(lonN)) {
    throw new Error(`Invalid coordinates: lat=${lat}, lon=${lon}`);
  }
  return `${latN},${lonN}`;
}
