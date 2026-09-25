import { MobileError } from "../errors.js";

export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new MobileError("Tool operation was cancelled.", "REQUEST_CANCELLED"));
  }
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));

  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new MobileError("Tool operation was cancelled.", "REQUEST_CANCELLED"));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
