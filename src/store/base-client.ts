import { sanitizeErrorMessage } from "../utils/sanitize.js";

/**
 * Abstract base for store API clients.
 *
 * Extracts common HTTP helpers shared by GooglePlayClient, HuaweiAppGalleryClient,
 * and RuStoreClient. Each subclass provides its own auth header via `authHeader()`.
 */
export abstract class AbstractStoreClient {
  /**
   * Returns the HTTP header used for authentication.
   * Override to customize (e.g. "Public-Token" for RuStore vs "Authorization" for Google/Huawei).
   */
  protected authHeader(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  /**
   * Generic JSON API call with error handling.
   * Subclasses that need a different error prefix can override `apiErrorPrefix`.
   */
  protected async api<T>(method: string, url: string, token: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: {
        ...this.authHeader(token),
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = sanitizeErrorMessage((await res.text()).slice(0, 200));
      throw new Error(`${this.apiErrorPrefix} ${res.status} ${method} ${url}: ${text}`);
    }
    if (res.status === 204 || res.headers.get("content-length") === "0") return {} as T;
    return res.json() as Promise<T>;
  }

  /** Prefix for API error messages (e.g. "Google Play API", "Huawei API"). */
  protected abstract get apiErrorPrefix(): string;

  /**
   * Reads a ReadableStream into a single Buffer.
   * Used by Huawei and RuStore for multipart file uploads.
   */
  protected async streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
}
