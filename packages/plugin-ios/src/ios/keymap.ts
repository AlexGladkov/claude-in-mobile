/**
 * iOS key mapping and AppleScript literals for the Simulator host.
 *
 * SECURITY: AppleScript strings here are fixed literals passed as distinct
 * argv slots to execFileSync("osascript", [...]). They never reach /bin/sh.
 */

export const IOS_KEY_MAP: Record<string, string> = {
  HOME: "home",
  BACK: "home", // iOS doesn't have back, use home
  VOLUME_UP: "volumeUp",
  VOLUME_DOWN: "volumeDown",
  LOCK: "lock",
};

/**
 * Resolve a logical key name to its simctl/AppleScript token.
 */
export function mapKey(key: string): string {
  return IOS_KEY_MAP[key.toUpperCase()] ?? key.toLowerCase();
}

/**
 * AppleScript argv that activates Simulator and triggers Cmd+Shift+H (home).
 */
export const HOME_KEY_OSASCRIPT_ARGS: readonly string[] = [
  "-e", 'tell application "Simulator" to activate',
  "-e", 'tell application "System Events" to keystroke "h" using {command down, shift down}',
];

/**
 * AppleScript argv that just brings Simulator to focus.
 */
export const ACTIVATE_SIMULATOR_OSASCRIPT_ARGS: readonly string[] = [
  "-e", 'tell application "Simulator" to activate',
];
