/**
 * Platform enablement config — which platform plugins the kernel loads.
 *
 * Resolution order (first wins):
 *   1. `CLAUDE_IN_MOBILE_PLATFORMS` env (csv, or `all` / `none`)
 *   2. `~/.claude-in-mobile/config.json` → `{ "platforms": [...] }`
 *   3. default: none (base is slim; platforms are opt-in / installed on demand)
 *
 * The `install` CLI writes the config file; the bootstrap reads it. Keeping the
 * default empty is what makes "base package, deliver platforms on demand" work.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ALL_PLATFORMS = [
  "android",
  "ios",
  "web",
  "desktop",
  "aurora",
] as const;

export type PlatformId = (typeof ALL_PLATFORMS)[number];

export function configPath(): string {
  return join(homedir(), ".claude-in-mobile", "config.json");
}

function isPlatformId(s: string): s is PlatformId {
  return (ALL_PLATFORMS as readonly string[]).includes(s);
}

/** Parse a csv / `all` / `none` platform spec into a deduped, valid list. */
export function parsePlatformList(raw: string): PlatformId[] {
  const t = raw.trim().toLowerCase();
  if (t === "" || t === "none") return [];
  if (t === "all") return [...ALL_PLATFORMS];
  const out = new Set<PlatformId>();
  for (const part of t.split(",")) {
    const p = part.trim();
    if (isPlatformId(p)) out.add(p);
  }
  return [...out];
}

function readConfigPlatforms(path = configPath()): PlatformId[] | undefined {
  try {
    const json = JSON.parse(readFileSync(path, "utf-8")) as {
      platforms?: unknown;
    };
    if (Array.isArray(json.platforms)) {
      return json.platforms.filter(
        (s): s is PlatformId => typeof s === "string" && isPlatformId(s)
      );
    }
  } catch {
    // missing/invalid config → treated as "no preference"
  }
  return undefined;
}

/** Resolve the enabled platform set per the documented precedence. */
export function resolveEnabledPlatforms(): PlatformId[] {
  const env = process.env.CLAUDE_IN_MOBILE_PLATFORMS;
  if (env !== undefined) return parsePlatformList(env);
  const fromConfig = readConfigPlatforms();
  if (fromConfig) return fromConfig;
  return [];
}

/** Persist the enabled platform set (used by `claude-in-mobile install`). */
export function writeEnabledPlatforms(
  platforms: readonly PlatformId[],
  path = configPath()
): void {
  const deduped = [...new Set(platforms)].filter(isPlatformId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ platforms: deduped }, null, 2) + "\n");
}
