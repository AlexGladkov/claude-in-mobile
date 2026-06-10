import { existsSync, readFileSync } from "fs";
import { AbstractStoreClient } from "./base-client.js";
import { mintAscToken } from "./asc-jwt.js";
import { sanitizeErrorMessage } from "../utils/sanitize.js";
import { AscAuthError, AscKeyMissingError, AscRateLimitError, MobileError } from "../errors/index.js";

const BASE = "https://api.appstoreconnect.apple.com";

interface AscCredentials {
  keyId: string;
  issuerId: string;
  privateKeyPem: string;
}

export interface AscApp {
  id: string;
  name: string;
}

export interface AscBuild {
  id: string;
  version: string;
  processingState: string;
  uploadedDate: string;
}

export interface AscBetaGroup {
  id: string;
  name: string;
  isInternal: boolean;
}

// ── JSON:API response shapes ──────────────────────────────────────────────────

interface AppsResponse {
  data?: Array<{ id: string; attributes?: { name?: string; bundleId?: string } }>;
}

interface BuildsResponse {
  data?: Array<{
    id: string;
    attributes?: { version?: string; processingState?: string; uploadedDate?: string; expired?: boolean };
  }>;
}

interface BetaBuildLocalizationsResponse {
  data?: Array<{ id: string; attributes?: { locale?: string } }>;
}

interface BetaGroupsResponse {
  data?: Array<{ id: string; attributes?: { name?: string; isInternalGroup?: boolean } }>;
}

/**
 * Loads App Store Connect API credentials from the environment ONLY.
 * Key material is never accepted from method arguments — this prevents the
 * model (or a tool caller) from ever seeing or relaying the private key.
 *
 * Primary env vars:  ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_FILE (.p8 path)
 *                    or ASC_PRIVATE_KEY (inline PEM)
 * Fastlane fallback: APP_STORE_CONNECT_API_KEY_KEY_ID,
 *                    APP_STORE_CONNECT_API_KEY_ISSUER_ID,
 *                    APP_STORE_CONNECT_API_KEY_KEY_FILEPATH / APP_STORE_CONNECT_API_KEY_KEY
 */
function loadCredentials(): AscCredentials {
  const keyId = process.env.ASC_KEY_ID ?? process.env.APP_STORE_CONNECT_API_KEY_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID ?? process.env.APP_STORE_CONNECT_API_KEY_ISSUER_ID;
  const keyFile = process.env.ASC_KEY_FILE ?? process.env.APP_STORE_CONNECT_API_KEY_KEY_FILEPATH;
  const inlineKey = process.env.ASC_PRIVATE_KEY ?? process.env.APP_STORE_CONNECT_API_KEY_KEY;

  if (!keyId || !issuerId) {
    throw new AscKeyMissingError();
  }
  if (keyFile && existsSync(keyFile)) {
    return { keyId, issuerId, privateKeyPem: readFileSync(keyFile, "utf8") };
  }
  if (inlineKey) {
    return { keyId, issuerId, privateKeyPem: inlineKey };
  }
  throw new AscKeyMissingError();
}

/** Non-secret ASC auth references, safe to pass into xcodebuild/altool argv. */
export interface AscEnvAuth {
  keyId: string;
  issuerId: string;
  /** Path to the .p8 key file when configured via ASC_KEY_FILE — required by xcodebuild. */
  keyPath?: string;
}

/**
 * Resolves keyId / issuerId / key-file PATH from the environment for tools
 * that shell out (xcodebuild archive/export, altool). Unlike loadCredentials,
 * this never reads the PEM contents — only a path reference leaves this
 * function, so no secret material can reach argv or the LLM context.
 */
export function getAscAuthFromEnv(): AscEnvAuth {
  const keyId = process.env.ASC_KEY_ID ?? process.env.APP_STORE_CONNECT_API_KEY_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID ?? process.env.APP_STORE_CONNECT_API_KEY_ISSUER_ID;
  const keyPath = process.env.ASC_KEY_FILE ?? process.env.APP_STORE_CONNECT_API_KEY_KEY_FILEPATH;
  if (!keyId || !issuerId) {
    throw new AscKeyMissingError();
  }
  return { keyId, issuerId, keyPath: keyPath || undefined };
}

export class AppStoreConnectClient extends AbstractStoreClient {
  private creds: AscCredentials | null = null;

  protected get apiErrorPrefix(): string {
    return "App Store Connect API";
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  /** Mints (or reuses a cached) ES256 JWT. Never logged or persisted. */
  private token(): string {
    if (!this.creds) {
      this.creds = loadCredentials();
    }
    try {
      return mintAscToken(this.creds).token;
    } catch (err) {
      if (err instanceof MobileError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new AscAuthError(sanitizeErrorMessage(msg.slice(0, 200)));
    }
  }

  /**
   * JSON:API request with ASC-specific status handling:
   * 401 → AscAuthError, 429 → AscRateLimitError (retryable),
   * other non-2xx → generic prefixed Error. Error bodies are always
   * sanitized + truncated before being embedded in messages.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { allowStatuses?: number[] }
  ): Promise<{ status: number; data: T }> {
    const token = this.token();
    const url = `${BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        ...this.authHeader(token),
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok && !(opts?.allowStatuses ?? []).includes(res.status)) {
      const text = sanitizeErrorMessage((await res.text()).slice(0, 200));
      if (res.status === 401) throw new AscAuthError(text);
      if (res.status === 429) throw new AscRateLimitError(text);
      throw new Error(`${this.apiErrorPrefix} ${res.status} ${method} ${url}: ${text}`);
    }

    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return { status: res.status, data: {} as T };
    }
    if (!res.ok) {
      // Allowed non-2xx (e.g. 409) — caller branches on status, body unused.
      return { status: res.status, data: {} as T };
    }
    return { status: res.status, data: (await res.json()) as T };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Resolves an app by bundle ID. */
  async findApp(bundleId: string): Promise<AscApp> {
    const { data } = await this.request<AppsResponse>(
      "GET",
      `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`
    );
    const app = data.data?.[0];
    if (!app) {
      throw new Error(`App Store Connect: no app found for bundleId "${bundleId}"`);
    }
    return { id: app.id, name: app.attributes?.name ?? bundleId };
  }

  /** Lists builds for an app, newest first. Optionally filtered by marketing version. */
  async getBuilds(appId: string, opts: { version?: string; limit?: number } = {}): Promise<AscBuild[]> {
    let query =
      `filter[app]=${encodeURIComponent(appId)}` +
      `&sort=-uploadedDate` +
      `&fields[builds]=processingState,version,uploadedDate,expired`;
    if (opts.version) {
      query += `&filter[preReleaseVersion.version]=${encodeURIComponent(opts.version)}`;
    }
    if (opts.limit !== undefined) {
      query += `&limit=${opts.limit}`;
    }

    const { data } = await this.request<BuildsResponse>("GET", `/v1/builds?${query}`);
    return (data.data ?? []).map(b => ({
      id: b.id,
      version: b.attributes?.version ?? "?",
      processingState: b.attributes?.processingState ?? "UNKNOWN",
      uploadedDate: b.attributes?.uploadedDate ?? "",
    }));
  }

  /**
   * Sets TestFlight "What to Test" notes for a build.
   * POST first; on 409 (localization already exists) finds it and PATCHes.
   */
  async setWhatToTest(buildId: string, whatsNew: string, locale = "en-US"): Promise<void> {
    const { status } = await this.request(
      "POST",
      "/v1/betaBuildLocalizations",
      {
        data: {
          type: "betaBuildLocalizations",
          attributes: { whatsNew, locale },
          relationships: { build: { data: { type: "builds", id: buildId } } },
        },
      },
      { allowStatuses: [409] }
    );
    if (status !== 409) return;

    // Localization already exists — find it and update in place.
    const { data } = await this.request<BetaBuildLocalizationsResponse>(
      "GET",
      `/v1/builds/${encodeURIComponent(buildId)}/betaBuildLocalizations`
    );
    const existing = (data.data ?? []).find(l => l.attributes?.locale === locale) ?? data.data?.[0];
    if (!existing) {
      throw new Error(`App Store Connect: no betaBuildLocalization found for build "${buildId}"`);
    }
    await this.request("PATCH", `/v1/betaBuildLocalizations/${encodeURIComponent(existing.id)}`, {
      data: {
        type: "betaBuildLocalizations",
        id: existing.id,
        attributes: { whatsNew },
      },
    });
  }

  /** Lists TestFlight beta groups for an app. */
  async getBetaGroups(appId: string): Promise<AscBetaGroup[]> {
    const { data } = await this.request<BetaGroupsResponse>(
      "GET",
      `/v1/betaGroups?filter[app]=${encodeURIComponent(appId)}`
    );
    return (data.data ?? []).map(g => ({
      id: g.id,
      name: g.attributes?.name ?? "?",
      isInternal: g.attributes?.isInternalGroup ?? false,
    }));
  }

  /** Assigns a build to a beta group (expects 204 No Content). */
  async addBuildToGroup(groupId: string, buildId: string): Promise<void> {
    await this.request("POST", `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`, {
      data: [{ type: "builds", id: buildId }],
    });
  }

  /** Submits a build for external TestFlight beta review. */
  async submitForBetaReview(buildId: string): Promise<void> {
    await this.request("POST", "/v1/betaAppReviewSubmissions", {
      data: {
        type: "betaAppReviewSubmissions",
        relationships: { build: { data: { type: "builds", id: buildId } } },
      },
    });
  }

  /** Marks a build as exempt from export-compliance encryption review. */
  async setEncryptionExempt(buildId: string, exempt = true): Promise<void> {
    await this.request("PATCH", `/v1/builds/${encodeURIComponent(buildId)}`, {
      data: {
        type: "builds",
        id: buildId,
        attributes: { usesNonExemptEncryption: !exempt },
      },
    });
  }
}
