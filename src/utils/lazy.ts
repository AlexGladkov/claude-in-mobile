/**
 * Creates a lazy singleton factory.
 *
 * The instance is created on first call and reused for all subsequent calls.
 * Useful for store clients that should be instantiated only when needed.
 */
export function createLazySingleton<T>(factory: () => T): () => T {
  let instance: T | null = null;
  return () => {
    if (!instance) instance = factory();
    return instance;
  };
}
