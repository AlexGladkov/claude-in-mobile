/**
 * Android KeyEvent constants used by AdbClient.pressKey / pressKeyAsync.
 *
 * Values mirror `android.view.KeyEvent.KEYCODE_*` and are the integers consumed
 * by `adb shell input keyevent <code>`. Two maps are kept on purpose:
 *
 * - `ANDROID_KEYCODES` — the full set used by the sync pressKey path.
 * - `ANDROID_KEYCODES_FAST` — a smaller hot-path subset used by the async
 *   "turbo" pressKey to avoid building the larger map on every call.
 *
 * `resolveKeyCode` accepts a symbolic name (case-insensitive) or a raw numeric
 * string, validating both into a finite integer.
 */

export const ANDROID_KEYCODES: Record<string, number> = {
  BACK: 4,
  HOME: 3,
  MENU: 82,
  ENTER: 66,
  TAB: 61,
  DELETE: 67,
  BACKSPACE: 67,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  VOLUME_MUTE: 164,
  CAMERA: 27,
  APP_SWITCH: 187,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  SEARCH: 84,
  ESCAPE: 111,
  SPACE: 62,
  WAKEUP: 224,
  SLEEP: 223,
  BRIGHTNESS_UP: 221,
  BRIGHTNESS_DOWN: 220,
  MEDIA_PLAY_PAUSE: 85,
  MEDIA_NEXT: 87,
  MEDIA_PREVIOUS: 88,
  MEDIA_STOP: 86,
  MUTE: 91,
  NOTIFICATION: 83,
  SETTINGS: 176,
  COPY: 278,
  PASTE: 279,
  CUT: 277,
};

export const ANDROID_KEYCODES_FAST: Record<string, number> = {
  BACK: 4, HOME: 3, MENU: 82, ENTER: 66, TAB: 61,
  DELETE: 67, BACKSPACE: 67, POWER: 26, VOLUME_UP: 24,
  VOLUME_DOWN: 25, ESCAPE: 111, SPACE: 62, DPAD_UP: 19,
  DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22,
};

/**
 * Translate a symbolic key name or numeric string into the corresponding
 * Android keyevent integer. Throws if `key` is neither a known name nor a
 * parsable integer.
 */
export function resolveKeyCode(
  key: string,
  table: Record<string, number> = ANDROID_KEYCODES
): number {
  const keyCode = table[key.toUpperCase()] ?? parseInt(key);
  if (isNaN(keyCode)) {
    throw new Error(`Unknown key: ${key}`);
  }
  return keyCode;
}
