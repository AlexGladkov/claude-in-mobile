/**
 * Status-code lookup tables for sensor commands.
 *
 * Hoisted out of `sensor-tools.ts` so the magic-number → name mapping lives in
 * a single place that is easy to audit against AOSP source.
 */

/** `dumpsys battery set status <code>` — codes from BatteryManager.BATTERY_STATUS_*. */
export const BATTERY_STATUS_CODES: Record<string, number> = {
  charging: 2,
  discharging: 3,
  "not-charging": 4,
  full: 5,
};

/** `cmd thermalservice override-status <code>` — codes from PowerManager.THERMAL_STATUS_*. */
export const THERMAL_STATUS_CODES: Record<string, number> = {
  none: 0,
  light: 1,
  moderate: 2,
  severe: 3,
  critical: 4,
  emergency: 5,
  shutdown: 6,
};
