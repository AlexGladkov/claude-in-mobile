/**
 * Platform management subcommands for the `claude-in-mobile` bin:
 *
 *   claude-in-mobile platforms              list enabled + available
 *   claude-in-mobile install <p|all>...     enable platform(s)
 *   claude-in-mobile uninstall <p>...        disable platform(s)
 *   claude-in-mobile doctor [p...]          check external toolchains
 *
 * These mutate ~/.claude-in-mobile/config.json (read by the kernel bootstrap).
 * Pure set math (applyInstall/applyUninstall) is split out for testing.
 */

import { execFileSync } from "node:child_process";

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

function isBinAvailable(bin: string): boolean {
  try {
    // `command -v` via /bin/sh — portable, no dependency on `which`.
    // `bin` is a fixed allowlisted token (see TOOLCHAIN), not user input.
    execFileSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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
      console.log(`Enable with: claude-in-mobile install <platform|all>`);
      break;
    }
    case "install": {
      if (rest.length === 0) {
        console.error("Usage: claude-in-mobile install <android|ios|web|desktop|aurora|all>...");
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
        console.log("No platforms enabled. `claude-in-mobile install <platform>` first.");
      } else {
        doctorReport(targets);
      }
      break;
    }
  }
  return exit(0);
}

function doctorReport(platforms: readonly PlatformId[]): void {
  console.log("\nToolchain check:");
  for (const p of platforms) {
    const tc = TOOLCHAIN[p];
    if (tc.probe.length === 0) {
      console.log(`  ${p}: ok (no external CLI required) — ${tc.hint}`);
      continue;
    }
    const missing = tc.probe.filter((b) => !isBinAvailable(b));
    if (missing.length === 0) {
      console.log(`  ${p}: ok (${tc.probe.join(", ")})`);
    } else {
      console.log(`  ${p}: MISSING ${missing.join(", ")} — ${tc.hint}`);
    }
  }
}
