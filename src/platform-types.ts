/**
 * Platform identifier types -- shared between device-manager facade and
 * its extracted helpers (src/device/*). Extracted in D9.1 to break a
 * potential circular import (helpers in src/device/ need `Platform` /
 * `Device` but device-manager.ts re-exports these for back-compat with
 * the ~125 import sites).
 *
 * Behaviour-preserving: device-manager.ts re-exports every symbol from
 * this file so existing imports `from "./device-manager.js"` keep working.
 */

/**
 * First-party platform identifiers. Listed explicitly so consumers (IDE
 * autocomplete, exhaustive switches that opt in via `assertNever`) still
 * see the canonical names.
 */
export type BuiltinPlatform = "android" | "ios" | "desktop" | "aurora" | "browser";

/**
 * Open platform identifier. Accepts any string at the type level, but
 * preserves IDE autocomplete for the built-in names via the
 * `string & {}` "branded string" trick. Third-party plugins can declare
 * `platform: "tizen"` without a core edit.
 */
export type Platform = BuiltinPlatform | (string & {});

export const BUILTIN_PLATFORMS: ReadonlyArray<BuiltinPlatform> = [
  "android",
  "ios",
  "desktop",
  "aurora",
  "browser",
];

export const isBuiltinPlatform = (p: string): p is BuiltinPlatform =>
  (BUILTIN_PLATFORMS as readonly string[]).includes(p);

export const assertNever = (p: never): never => {
  throw new Error(`Unhandled platform: ${String(p)}`);
};

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  state: string;
  isSimulator: boolean;
}
