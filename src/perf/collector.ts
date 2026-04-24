/**
 * Platform-specific performance metric collection.
 *
 * All ADB shell commands are hardcoded strings — user input (package names)
 * is validated via validatePackageName() before interpolation.
 */

import type { AdbClient } from "../adb/client.js";
import type { DesktopClient } from "../desktop/client.js";
import type { PerfSnapshot, CrashEntry } from "./types.js";
import { validatePackageName } from "../utils/sanitize.js";
import { sanitizeErrorMessage } from "../utils/sanitize.js";

// ── Parsing helpers ──

function parseMemoryFromDumpsys(output: string): { usedMb: number; totalMb: number } | null {
  // Look for "TOTAL PSS:" or "TOTAL:" line
  const totalPssMatch = output.match(/TOTAL\s+PSS:\s+([\d,]+)/i)
    ?? output.match(/TOTAL:\s+([\d,]+)/i)
    ?? output.match(/TOTAL\s+([\d,]+)/);

  if (!totalPssMatch) return null;

  const pssKb = parseInt(totalPssMatch[1].replace(/,/g, ""), 10);
  if (isNaN(pssKb)) return null;

  // Get total device memory from the same output or return 0
  const totalMatch = output.match(/Total RAM:\s+([\d,]+)/i);
  const totalKb = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ""), 10) : 0;

  return {
    usedMb: Math.round((pssKb / 1024) * 10) / 10,
    totalMb: Math.round((totalKb / 1024) * 10) / 10,
  };
}

function parseCpuFromDumpsys(output: string, packageName: string): { appPercent: number } | null {
  // dumpsys cpuinfo format: "  12.3% 12345/com.example.app: 8% user + 4.3% kernel"
  // Or top format: "12345 ... 12.3 ... com.example.app"
  const lines = output.split("\n");
  for (const line of lines) {
    if (line.includes(packageName)) {
      const percentMatch = line.match(/([\d.]+)%/);
      if (percentMatch) {
        const percent = parseFloat(percentMatch[1]);
        if (!isNaN(percent)) return { appPercent: percent };
      }
    }
  }
  return null;
}

function parseFpsFromGfxinfo(output: string): { current: number; jankyFrames?: number; totalFrames?: number } | null {
  const totalMatch = output.match(/Total frames rendered:\s*(\d+)/);
  const jankyMatch = output.match(/Janky frames:\s*(\d+)/);

  if (!totalMatch) return null;

  const totalFrames = parseInt(totalMatch[1], 10);
  const jankyFrames = jankyMatch ? parseInt(jankyMatch[1], 10) : undefined;

  // Estimate FPS from frame stats (if available)
  // Look for "50th percentile:" line for frame time
  const percentileMatch = output.match(/50th percentile:\s*(\d+)ms/);
  let current = 60; // Default assumption
  if (percentileMatch) {
    const frameTimeMs = parseInt(percentileMatch[1], 10);
    if (frameTimeMs > 0) {
      current = Math.min(60, Math.round(1000 / frameTimeMs));
    }
  }

  return { current, jankyFrames, totalFrames };
}

function parseBatteryFromDumpsys(output: string): { level: number; temperature?: number; charging: boolean } | null {
  const levelMatch = output.match(/level:\s*(\d+)/i);
  if (!levelMatch) return null;

  const level = parseInt(levelMatch[1], 10);
  const tempMatch = output.match(/temperature:\s*(\d+)/i);
  const statusMatch = output.match(/status:\s*(\d+)/i);

  // Battery status: 2 = Charging, 5 = Full
  const charging = statusMatch ? [2, 5].includes(parseInt(statusMatch[1], 10)) : false;
  const temperature = tempMatch ? parseInt(tempMatch[1], 10) / 10 : undefined;

  return { level, temperature, charging };
}

function parseCrashesFromLogcat(output: string): CrashEntry[] {
  const crashes: CrashEntry[] = [];
  const lines = output.split("\n");

  let inFatalBlock = false;
  let currentCrash: Partial<CrashEntry> | null = null;

  for (const line of lines) {
    // Detect FATAL EXCEPTION blocks
    if (line.includes("FATAL EXCEPTION")) {
      if (currentCrash?.summary) {
        crashes.push(currentCrash as CrashEntry);
      }
      const tsMatch = line.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)/);
      const processMatch = line.match(/Process:\s*(\S+)/);
      currentCrash = {
        type: "crash",
        timestamp: tsMatch?.[1] ?? new Date().toISOString(),
        process: processMatch?.[1],
        summary: "",
      };
      inFatalBlock = true;
      continue;
    }

    // Capture first exception line after FATAL EXCEPTION
    if (inFatalBlock && currentCrash && !currentCrash.summary) {
      const exceptionMatch = line.match(/([\w.]+(?:Exception|Error|Throwable)[^:\n]*(?::\s*[^\n]{0,120})?)/);
      if (exceptionMatch) {
        currentCrash.summary = sanitizeCrashSummary(exceptionMatch[1]);
        inFatalBlock = false;
      }
    }

    // Detect ANR lines
    if (line.includes("ANR in")) {
      const tsMatch = line.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)/);
      const anrMatch = line.match(/ANR in\s+(\S+)/);
      // Reason may be on the same line or the next line
      let reason = line.match(/Reason:\s*(.+)/)?.[1];
      if (!reason) {
        // Look ahead for Reason line
        const lineIdx = lines.indexOf(line);
        for (let j = lineIdx + 1; j < Math.min(lineIdx + 3, lines.length); j++) {
          const reasonMatch = lines[j].match(/Reason:\s*(.+)/);
          if (reasonMatch) {
            reason = reasonMatch[1];
            break;
          }
        }
      }
      crashes.push({
        type: "anr",
        timestamp: tsMatch?.[1] ?? new Date().toISOString(),
        process: anrMatch?.[1],
        summary: sanitizeCrashSummary(reason ?? "ANR detected"),
      });
    }

    // Detect native crashes
    if (line.includes("*** *** *** *** *** *** *** ***")) {
      const tsMatch = line.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)/);
      crashes.push({
        type: "native_crash",
        timestamp: tsMatch?.[1] ?? new Date().toISOString(),
        summary: "Native crash (tombstone)",
      });
    }
  }

  // Push last pending crash
  if (currentCrash?.summary) {
    crashes.push(currentCrash as CrashEntry);
  }

  return crashes;
}

function sanitizeCrashSummary(summary: string): string {
  return sanitizeErrorMessage(summary).slice(0, 200);
}

// ── Public collector functions ──

/**
 * Detect foreground package from Android device.
 */
export function detectForegroundPackage(adb: AdbClient): string | undefined {
  try {
    const activity = adb.getCurrentActivity();
    if (activity && activity !== "unknown" && !activity.includes("could not determine")) {
      // Activity format: com.example.app/.MainActivity or com.example.app/com.example.app.MainActivity
      const pkg = activity.split("/")[0];
      if (pkg) return pkg;
    }
  } catch {
    // Fall through
  }
  return undefined;
}

/**
 * Collect performance snapshot from Android device.
 */
export function collectAndroidSnapshot(adb: AdbClient, packageName: string): PerfSnapshot {
  validatePackageName(packageName);

  let memory: PerfSnapshot["memory"] = null;
  let cpu: PerfSnapshot["cpu"] = null;
  let fps: PerfSnapshot["fps"] = null;
  let battery: PerfSnapshot["battery"] = null;
  let crashes: CrashEntry[] = [];

  // Memory via dumpsys meminfo
  try {
    const memOutput = adb.exec(`shell dumpsys meminfo ${packageName}`);
    memory = parseMemoryFromDumpsys(memOutput);
  } catch {
    // Memory collection failed — non-fatal
  }

  // CPU via dumpsys cpuinfo
  try {
    const cpuOutput = adb.exec("shell dumpsys cpuinfo");
    cpu = parseCpuFromDumpsys(cpuOutput, packageName);
  } catch {
    // CPU collection failed — non-fatal
  }

  // FPS via dumpsys gfxinfo
  try {
    const gfxOutput = adb.exec(`shell dumpsys gfxinfo ${packageName}`);
    fps = parseFpsFromGfxinfo(gfxOutput);
  } catch {
    // FPS collection failed — non-fatal
  }

  // Battery via dumpsys battery
  try {
    const battOutput = adb.getBatteryInfo();
    battery = parseBatteryFromDumpsys(battOutput);
  } catch {
    // Battery collection failed — non-fatal
  }

  // Crashes via logcat
  try {
    const crashOutput = adb.exec("shell logcat -d -s AndroidRuntime:E -t 30");
    const anrOutput = adb.exec("shell logcat -d -s ActivityManager:E -t 30");
    crashes = [
      ...parseCrashesFromLogcat(crashOutput),
      ...parseCrashesFromLogcat(anrOutput),
    ];
  } catch {
    // Crash log collection failed — non-fatal
  }

  return {
    platform: "android",
    timestamp: new Date().toISOString(),
    packageName,
    memory,
    cpu,
    fps,
    battery,
    crashes,
  };
}

/**
 * Collect performance snapshot from Desktop client.
 */
export async function collectDesktopSnapshot(desktop: DesktopClient): Promise<PerfSnapshot> {
  let memory: PerfSnapshot["memory"] = null;
  let cpu: PerfSnapshot["cpu"] = null;
  let fps: PerfSnapshot["fps"] = null;
  const crashes: CrashEntry[] = [];

  try {
    const metrics = await desktop.getPerformanceMetrics();
    if (metrics.memoryUsageMb !== undefined) {
      memory = { usedMb: metrics.memoryUsageMb, totalMb: 0 };
    }
    if (metrics.cpuPercent !== undefined) {
      cpu = { appPercent: metrics.cpuPercent };
    }
    if (metrics.fps !== undefined) {
      fps = { current: metrics.fps };
    }
  } catch {
    // Metrics collection failed — non-fatal
  }

  // Check desktop state for crashes
  try {
    const state = desktop.getState();
    if (state.crashCount > 0) {
      crashes.push({
        type: "crash",
        timestamp: new Date().toISOString(),
        summary: `Desktop crash count: ${state.crashCount}${state.lastError ? ` — ${sanitizeCrashSummary(state.lastError)}` : ""}`,
      });
    }
  } catch {
    // State check failed — non-fatal
  }

  return {
    platform: "desktop",
    timestamp: new Date().toISOString(),
    memory,
    cpu,
    fps,
    battery: null,
    crashes,
  };
}

/**
 * Collect performance snapshot for iOS (very limited).
 */
export function collectIosSnapshot(): PerfSnapshot {
  return {
    platform: "ios",
    timestamp: new Date().toISOString(),
    memory: null,
    cpu: null,
    fps: null,
    battery: null,
    crashes: [],
  };
}

// Export parsing functions for testing
export {
  parseMemoryFromDumpsys,
  parseCpuFromDumpsys,
  parseFpsFromGfxinfo,
  parseBatteryFromDumpsys,
  parseCrashesFromLogcat,
};
