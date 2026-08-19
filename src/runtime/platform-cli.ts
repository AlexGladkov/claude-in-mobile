/**
 * Platform management subcommands for the `mcp-devices` bin:
 *
 *   mcp-devices platforms              list enabled + available
 *   mcp-devices install <p|all>...     enable platform(s)
 *   mcp-devices uninstall <p>...        disable platform(s)
 *   mcp-devices doctor [p...]          check external toolchains
 *
 * These mutate ~/.mcp-devices/config.json (read by the kernel bootstrap).
 * Pure set math (applyInstall/applyUninstall) is split out for testing.
 */

import { isBinAvailable } from "../utils/which-bin.js";
import {
  ALL_PLATFORMS,
  parsePlatformList,
  resolveEnabledPlatforms,
  writeEnabledPlatforms,
  type PlatformId,
} from "./platform-config.js";

export const PLATFORM_COMMANDS = [
  "platforms",
  "install",
  "uninstall",
  "doctor",
] as const;

/** External toolchain probed by `doctor`, per platform. */
const TOOLCHAIN: Record<PlatformId, { probe: string[]; hint: string }> = {
  android: { probe: ["adb"], hint: "Android platform-tools (e.g. `brew install android-platform-tools`)" },
  ios: { probe: ["xcrun"], hint: "Xcode CLT (`xcode-select --install`); physical devices also need go-ios (`npm i -g go-ios`)" },
  web: { probe: [], hint: "Chrome/Chromium — launched on demand by the bundled CDP client" },
  desktop: { probe: ["java"], hint: "JDK for the desktop companion" },
  aurora: { probe: ["flutter-aurora"], hint: "Aurora Flutter SDK (`flutter-aurora`)" },
};

/** Add platforms (csv / `all`) to the current set, deduped. */
export function applyInstall(
  current: readonly PlatformId[],
  args: readonly string[]
): PlatformId[] {
  const add = args.flatMap((a) => parsePlatformList(a));
  return [...new Set([...current, ...add])];
}

/** Remove platforms (csv / `all`) from the current set. */
export function applyUninstall(
  current: readonly PlatformId[],
  args: readonly string[]
): PlatformId[] {
  const remove = new Set(args.flatMap((a) => parsePlatformList(a)));
  return current.filter((p) => !remove.has(p));
}

/**
 * Dispatch a platform subcommand. Returns false (and does nothing) when argv
 * carries no platform command, so the caller can fall through to other CLI
 * handling. On a match it runs the command and `process.exit`s.
 */
export function runPlatformCommand(
  argv: readonly string[],
  exit: (code: number) => never = process.exit
): boolean {
  const cmd = argv[2];
  if (!cmd || !(PLATFORM_COMMANDS as readonly string[]).includes(cmd)) return false;
  const rest = argv.slice(3);

  switch (cmd) {
    case "platforms": {
      const enabled = resolveEnabledPlatforms();
      console.log(`Enabled:   ${enabled.join(", ") || "none (slim base)"}`);
      console.log(`Available: ${ALL_PLATFORMS.join(", ")}`);
      console.log(`Enable with: mcp-devices install <platform|all>`);
      break;
    }
    case "install": {
      if (rest.length === 0) {
        console.error("Usage: mcp-devices install <android|ios|web|desktop|aurora|all>...");
        return exit(1);
      }
      const next = applyInstall(resolveEnabledPlatforms(), rest);
      writeEnabledPlatforms(next);
      console.log(`Enabled platforms: ${next.join(", ") || "none"}`);
      console.log("Restart your MCP client (or server) to apply.");
      doctorReport(next);
      break;
    }
    case "uninstall": {
      const next = applyUninstall(resolveEnabledPlatforms(), rest);
      writeEnabledPlatforms(next);
      console.log(`Enabled platforms: ${next.join(", ") || "none"}`);
      console.log("Restart your MCP client (or server) to apply.");
      break;
    }
    case "doctor": {
      const targets = rest.length ? applyInstall([], rest) : resolveEnabledPlatforms();
      if (targets.length === 0) {
        console.log("No platforms enabled. `mcp-devices install <platform>` first.");
      } else {
        doctorReport(targets);
      }
      break;
    }
  }
  return exit(0);
}

/** One platform's toolchain verdict — pure, so it can be unit-tested. */
export interface ProbeResult {
  platform: PlatformId;
  /** Probes that were not found on PATH (empty = ok). */
  missing: string[];
  hint: string;
  /** True when this platform needs no external CLI (e.g. web). */
  noExternalCli: boolean;
}

/**
 * Evaluate a platform's toolchain against a presence check. `present` is
 * injectable so tests can exercise the found/missing branches without
 * spawning real processes (closes the doctor regression test gap).
 */
export function probePlatform(
  platform: PlatformId,
  present: (bin: string) => boolean = isBinAvailable
): ProbeResult {
  const tc = TOOLCHAIN[platform];
  if (tc.probe.length === 0) {
    return { platform, missing: [], hint: tc.hint, noExternalCli: true };
  }
  return {
    platform,
    missing: tc.probe.filter((b) => !present(b)),
    hint: tc.hint,
    noExternalCli: false,
  };
}

/** Render a single probe result as the doctor prints it. */
export function formatProbe(r: ProbeResult): string {
  if (r.noExternalCli) {
    return `  ${r.platform}: ok (no external CLI required) — ${r.hint}`;
  }
  const probes = TOOLCHAIN[r.platform].probe.join(", ");
  if (r.missing.length === 0) return `  ${r.platform}: ok (${probes})`;
  return `  ${r.platform}: MISSING ${r.missing.join(", ")} — ${r.hint}`;
}

function doctorReport(platforms: readonly PlatformId[]): void {
  console.log("\nToolchain check:");
  for (const p of platforms) {
    console.log(formatProbe(probePlatform(p)));
  }
}
