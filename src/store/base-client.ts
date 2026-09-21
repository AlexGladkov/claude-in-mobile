const MAX_STORE_JSON_BYTES = 4 * 1024 * 1024;

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
  protected async api(method: string, url: string, token: string, body?: unknown): Promise<unknown> {
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    if (
      serializedBody !== undefined
      && Buffer.byteLength(serializedBody, "utf8") > MAX_STORE_JSON_BYTES
    ) {
      throw new Error(`${this.apiErrorPrefix} request body exceeded the size limit.`);
    }
    const res = await this.fetchWithTimeout(url, {
      method,
      headers: {
        ...this.authHeader(token),
        "Content-Type": "application/json",
      },
      body: serializedBody,
    });

    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`${this.apiErrorPrefix} request failed with HTTP ${res.status}.`);
    }
    if (res.status === 204 || res.headers.get("content-length") === "0") return {};
    return this.readJson(res);
  }

  protected async readJson(response: Response): Promise<unknown> {
    return JSON.parse(await this.readText(response, MAX_STORE_JSON_BYTES));
  }

  protected async readText(response: Response, maxBytes: number): Promise<string> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_STORE_JSON_BYTES) {
      throw new Error("Invalid store response size limit.");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel();
      throw new Error(`${this.apiErrorPrefix} response exceeded the size limit.`);
    }
    if (!response.body) {
      throw new Error(`${this.apiErrorPrefix} returned no response body.`);
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${this.apiErrorPrefix} response exceeded the size limit.`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }

  /** Prefix for API error messages (e.g. "Google Play API", "Huawei API"). */
  protected abstract get apiErrorPrefix(): string;

  protected fetchWithTimeout(
    input: string | URL,
    init: RequestInit,
    timeoutMs = 60_000,
  ): Promise<Response> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) {
      throw new Error("Invalid store request timeout.");
    }
    return fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}
