/**
 * Pure, stateless parsers for ADB command output.
 * Extracted from client.ts (D9.10) so each parser can be unit-tested in isolation.
 * No I/O, no side effects, no dependency on AdbClient state.
 */

import type { Device } from "./client.js";

/**
 * Parse the output of `adb devices -l` into a list of Device records.
 * Input format (header followed by one device per line):
 *   List of devices attached
 *   emulator-5554   device product:sdk_gphone model:Pixel_5
 */
export function parseDevicesOutput(output: string): Device[] {
  const lines = output.split("\n").slice(1); // Skip header
  return lines
    .filter(line => line.trim())
    .map(line => {
      const parts = line.split(/\s+/);
      const id = parts[0];
      const state = parts[1];
      const modelMatch = line.match(/model:(\S+)/);
      return { id, state, model: modelMatch?.[1] };
    });
}

/**
 * Parse `adb shell wm size` output ("Physical size: 1080x1920") into width/height.
 * Falls back to 1080x1920 when the output does not contain a size pattern.
 */
export function parseScreenSize(output: string): { width: number; height: number } {
  const match = output.match(/(\d+)x(\d+)/);
  return {
    width: match ? parseInt(match[1]) : 1080,
    height: match ? parseInt(match[2]) : 1920,
  };
}

/** Ordered regex patterns for `dumpsys activity activities` across Android versions. */
const ACTIVITY_PATTERNS: RegExp[] = [
  /mResumedActivity[^}]*?(\S+\/\.\S+)/,        // Android 10+
  /mResumedActivity[^}]*?(\S+\/\S+)/,          // Generic
  /resumedActivity[^}]*?(\S+\/\S+)/,           // Some versions
  /topResumedActivity[^}]*?(\S+\/\S+)/,        // Android 12+
  /mFocusedActivity[^}]*?(\S+\/\S+)/,          // Older Android
  /ResumedActivity[^}]*?(\S+\/\S+)/i,          // Case-insensitive fallback
];

/**
 * Parse `dumpsys activity activities` output. Returns the resumed activity
 * component (`package/.Activity`) or null if no pattern matched.
 */
export function parseCurrentActivityFromActivities(output: string): string | null {
  for (const pattern of ACTIVITY_PATTERNS) {
    const match = output.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Parse `dumpsys window windows` looking for `mCurrentFocus`. Returns the
 * component reference or null if absent.
 */
export function parseCurrentFocusFromWindows(output: string): string | null {
  const focusMatch = output.match(/mCurrentFocus[^}]*?(\S+\/\S+)/);
  return focusMatch?.[1] ?? null;
}

/**
 * Filter lines of `dumpsys window` to ones mentioning current focus or
 * focused app, then extract the first `package/Activity` token.
 */
export function parseFocusFromDumpsysWindow(output: string): string | null {
  const filtered = output
    .split("\n")
    .filter(line => /mCurrentFocus|mFocusedApp/.test(line))
    .join("\n");
  const match = filtered.match(/(\S+\/\S+)/);
  return match?.[1] ?? null;
}

/**
 * Determine whether the currently-focused window has `FLAG_SECURE` set by
 * parsing `dumpsys window`. Secure windows make the OS return an all-black
 * frame for `screencap` (banking / auth / DRM apps), so detecting this lets
 * callers advise the accessibility-tree fallback instead of a silent black
 * screenshot.
 *
 * Strategy: isolate the focused window's block (windows are printed as
 * `Window #N Window{...}:` sections) and look for a decoded `fl=... SECURE`
 * flag line inside it. If the focused block cannot be isolated, fall back to
 * a global presence check — callers only invoke this after a frame already
 * looks blank, so a conservative match is acceptable.
 */
export function parseWindowSecureFlag(output: string, focusToken?: string): boolean {
  const focus = focusToken ?? parseCurrentFocusFromWindows(output) ?? undefined;
  const secureInBlock = (block: string): boolean =>
    /\bfl=[^\n]*\bSECURE\b/i.test(block) || /FLAG_SECURE/.test(block);

  if (focus) {
    // Split into per-window blocks; a header line looks like `  Window #3 Window{...}:`
    const blocks = output.split(/(?=^\s*Window #\d+\b)/m);
    const focused = blocks.find((b) => b.includes(focus));
    if (focused) return secureInBlock(focused);
  }

  // Fallback: no focused block isolated — treat any decoded SECURE flag as a hit.
  return secureInBlock(output);
}

/**
 * Parse `am broadcast -a clipper.get` result for `data="..."` payload.
 */
export function parseClipboardBroadcast(output: string): string | null {
  const match = output.match(/data="([^"]*)"/);
  return match?.[1] ?? null;
}

/**
 * Parse `cmd package resolve-activity --brief <pkg>` output and return the
 * first line containing a `/` (the component name), trimmed.
 */
export function parseLaunchActivity(output: string): string | null {
  const activity = output.split("\n").find(line => line.includes("/"));
  return activity ? activity.trim() : null;
}

/**
 * Strip the "UI hierachy dumped to: /dev/tty" prefix that some devices
 * prepend when dumping uiautomator XML to stdout via /dev/tty.
 */
export function stripDumpPrefix(raw: string): string {
  const idx = raw.indexOf("<?xml");
  if (idx > 0) return raw.slice(idx);
  return raw;
}

/**
 * Split combined `action && uiautomator dump /dev/tty` output into the
 * pre-XML action stdout and the trimmed UI XML. Returns empty `uiXml`
 * if no XML root marker was found.
 */
export function splitActionAndUiXml(raw: string): { actionOutput: string; uiXml: string } {
  const xmlStart = raw.indexOf("<?xml");
  const xmlStartAlt = raw.indexOf("<hierarchy");
  const splitIdx = xmlStart >= 0 ? xmlStart : xmlStartAlt;

  if (splitIdx < 0) {
    return { actionOutput: raw.trim(), uiXml: "" };
  }

  return {
    actionOutput: raw.substring(0, splitIdx).trim(),
    uiXml: stripDumpPrefix(raw.substring(splitIdx)),
  };
}
