import type { Platform, BuiltinPlatform } from "../../device-manager.js";

/**
 * Map of per-platform handlers. Each key is a built-in platform id and the
 * value is a sync or async producer of the result. A handler may be omitted —
 * the platforms left out fall through to `unsupported`.
 *
 * `unsupported` is the catch-all for platforms that have no entry in the map
 * (either because they aren't built-in, or because the caller intentionally
 * left them out). If omitted, a uniform `Error` is thrown describing the
 * unsupported platform.
 */
export type PlatformDispatchMap<T> = Partial<
  Record<BuiltinPlatform, () => T | Promise<T>>
> & {
  unsupported?: (platform: Platform) => T | Promise<T>;
};

/**
 * Dispatch on a runtime `Platform` value to the matching branch in `map`.
 *
 * - Returns synchronously when the chosen branch returns synchronously.
 * - Returns a Promise when the chosen branch is async.
 *
 * If no branch matches and no `unsupported` handler is provided, throws a
 * uniform `Error` describing the unsupported platform.
 */
export function dispatchByPlatform<T>(
  platform: Platform,
  map: PlatformDispatchMap<T>,
): T | Promise<T> {
  const handler = (map as Record<string, (() => T | Promise<T>) | undefined>)[platform];
  if (handler) {
    return handler();
  }
  if (map.unsupported) {
    return map.unsupported(platform);
  }
  throw new Error(`Operation is not supported on platform "${platform}".`);
}
