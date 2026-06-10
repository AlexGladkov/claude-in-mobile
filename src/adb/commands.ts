/**
 * Centralised ADB shell command builders.
 *
 * Hoist all `adb shell ...` strings here so:
 *   - security audit has a single surface
 *   - command changes are one-edit
 *   - tests can mock by string equality
 */

export const BATTERY = {
  RESET: "dumpsys battery reset",
  SET_LEVEL: (n: number) => `dumpsys battery set level ${n}`,
  SET_STATUS: (s: number) => `dumpsys battery set status ${s}`,
  SET_AC: (on: boolean) => `dumpsys battery set ac ${on ? 1 : 0}`,
  SET_USB: (on: boolean) => `dumpsys battery set usb ${on ? 1 : 0}`,
  UNPLUG: "dumpsys battery unplug",
  DUMP: "dumpsys battery",
} as const;

export const MOCK_LOCATION_GRANT =
  "appops set com.android.shell android:mock_location allow";

export const PIDOF = (pkg: string) => `pidof -s ${pkg}`;

export const AM = {
  START_VIEW: (url: string) =>
    `am start -a android.intent.action.VIEW -d '${url}'`,
  BROADCAST: (action: string) => `am broadcast -a ${action}`,
  FORCE_STOP: (pkg: string) => `am force-stop ${pkg}`,
} as const;

export const SCREEN = {
  CAP: "screencap -p",
  REC: (path: string, timeLimit?: number) =>
    `screenrecord ${timeLimit ? `--time-limit ${timeLimit} ` : ""}${path}`,
} as const;

export const INPUT = {
  TAP: (x: number, y: number) => `input tap ${x} ${y}`,
  SWIPE: (x1: number, y1: number, x2: number, y2: number, durationMs = 300) =>
    `input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`,
  KEYEVENT: (code: number | string) => `input keyevent ${code}`,
  TEXT: (escaped: string) => `input text ${escaped}`,
} as const;
