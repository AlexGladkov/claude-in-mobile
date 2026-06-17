/**
 * In-memory TTL cache for the UI hierarchy XML emitted by `uiautomator dump`.
 *
 * The cache is active only when the AdbClient is invoked in "turbo" mode: a
 * stale-but-fresh-enough tree (within `ttlMs`) is returned instantly instead of
 * triggering another ~150-300ms adb shell roundtrip.
 *
 * The cache is invalidated explicitly after any action that mutates the screen
 * (tap, swipe, input, etc.) — see AdbClient#invalidateUiTreeCache.
 */
export class UiTreeCache {
  private entry: { xml: string; timestamp: number } | null = null;

  constructor(private readonly ttlMs: number = 500) {}

  /** Returns the cached XML if it is still fresh, otherwise null. */
  get(): string | null {
    if (this.entry && Date.now() - this.entry.timestamp < this.ttlMs) {
      return this.entry.xml;
    }
    return null;
  }

  /** Replace the cache with the given XML, stamped to now. */
  set(xml: string): void {
    this.entry = { xml, timestamp: Date.now() };
  }

  /** Drop the cached entry. Next get() returns null until set() is called again. */
  invalidate(): void {
    this.entry = null;
  }
}
