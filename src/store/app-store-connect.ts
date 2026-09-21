import { closeSync, constants, fstatSync, openSync, readFileSync } from "fs";
import { z } from "zod";
import { AbstractStoreClient } from "./base-client.js";
import { mintAscToken } from "./asc-jwt.js";
import {
  sanitizeErrorMessage,
  validateAscIssuerId,
  validateAscKeyId,
} from "../utils/sanitize.js";
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

function validateBundleId(value: string): void {
  if (value.length > 255 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value)) {
    throw new Error("Invalid App Store Connect bundle identifier.");
  }
}

function validateAscResourceId(value: string, field = "resource identifier"): void {
  if (value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid App Store Connect ${field}.`);
  }
}

const ascRecordSchema = z.record(z.string(), z.unknown());
const ascItemsResponseSchema = z.object({
  data: z.array(ascRecordSchema),
}).passthrough();
const ascTextSchema = z.string().min(1).max(4096).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "text contains control characters",
);
const ascAppItemSchema = z.object({
  id: ascTextSchema,
  attributes: z.object({
    name: ascTextSchema.optional(),
  }).passthrough().optional(),
}).passthrough();
const ascBuildItemSchema = z.object({
  id: ascTextSchema,
  attributes: z.object({
    version: ascTextSchema.optional(),
    processingState: ascTextSchema.optional(),
    uploadedDate: ascTextSchema.optional(),
  }).passthrough(),
}).passthrough();
const ascLocalizationItemSchema = z.object({
  id: ascTextSchema,
  attributes: z.object({
    locale: ascTextSchema.optional(),
  }).passthrough().optional(),
}).passthrough();
const ascBetaGroupItemSchema = z.object({
  id: ascTextSchema,
  attributes: z.object({
    name: ascTextSchema.optional(),
    isInternalGroup: z.boolean(),
  }).passthrough(),
}).passthrough();

function parseAscItems(value: unknown, maxItems = 1000): Array<Record<string, unknown>> {
  const result = ascItemsResponseSchema.safeParse(value);
  if (!result.success || result.data.data.length > maxItems) {
    throw new Error("App Store Connect returned invalid data.");
  }
  return result.data.data;
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
  validateAscKeyId(keyId ?? "");
  validateAscIssuerId(issuerId ?? "");
  if (keyFile) {
    let fd: number | undefined;
    try {
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      fd = openSync(keyFile, constants.O_RDONLY | noFollow);
      const metadata = fstatSync(fd);
      if (!metadata.isFile() || metadata.size > 1024 * 1024) {
        throw new AscAuthError("App Store Connect private key is invalid or exceeds the size limit.");
      }
      return { keyId, issuerId, privateKeyPem: readFileSync(fd, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof AscAuthError) throw error;
        throw new AscAuthError("Unable to read the App Store Connect private key.");
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  if (inlineKey && Buffer.byteLength(inlineKey, "utf8") <= 1024 * 1024) {
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
  validateAscKeyId(keyId ?? "");
  validateAscIssuerId(issuerId ?? "");
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
    } catch (error: unknown) {
      if (error instanceof MobileError) throw error;
      throw new AscAuthError("Failed to mint App Store Connect credentials.");
    }
  }

  /**
   * JSON:API request with ASC-specific status handling:
   * 401 → AscAuthError, 429 → AscRateLimitError (retryable),
   * other non-2xx → generic prefixed Error. Error bodies are always
   * sanitized + truncated before being embedded in messages.
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts?: { allowStatuses?: number[] }
  ): Promise<{ status: number; data: unknown }> {
    const token = this.token();
    const url = `${BASE}${path}`;
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    if (serializedBody !== undefined && Buffer.byteLength(serializedBody, "utf8") > 4 * 1024 * 1024) {
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

    if (!res.ok && !(opts?.allowStatuses ?? []).includes(res.status)) {
      if (res.status === 401) {
        await res.body?.cancel();
        throw new AscAuthError("App Store Connect rejected the credentials.");
      }
      if (res.status === 429) {
        await res.body?.cancel();
        throw new AscRateLimitError("App Store Connect rate limit exceeded.");
      }
      const details = sanitizeErrorMessage(await this.readText(res, 16 * 1024)).slice(0, 200);
      throw new Error(`${this.apiErrorPrefix} ${res.status}: ${details || "request failed"}`);
    }

    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return { status: res.status, data: {} };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { status: res.status, data: {} };
    }
    return { status: res.status, data: await this.readJson(res) };
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Resolves an app by bundle ID. */
  async findApp(bundleId: string): Promise<AscApp> {
    validateBundleId(bundleId);
    const { data } = await this.request(
      "GET",
      `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`
    );
    const appValue = parseAscItems(data, 100)[0];
    if (!appValue) {
      throw new Error(`App Store Connect: no app found for bundleId "${bundleId}"`);
    }
    const appResult = ascAppItemSchema.safeParse(appValue);
    if (!appResult.success) {
      throw new Error("App Store Connect returned invalid app metadata.");
    }
    return {
      id: appResult.data.id,
      name: appResult.data.attributes?.name ?? bundleId,
    };
  }

  /** Lists builds for an app, newest first. Optionally filtered by marketing version. */
  async getBuilds(appId: string, opts: { version?: string; limit?: number } = {}): Promise<AscBuild[]> {
    validateAscResourceId(appId, "application identifier");
    if (
      opts.version !== undefined
      && (opts.version.length === 0 || opts.version.length > 64 || /[\u0000-\u001f\u007f]/.test(opts.version))
    ) {
      throw new Error("Invalid App Store Connect marketing version.");
    }
    if (
      opts.limit !== undefined
      && (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 200)
    ) {
      throw new Error("App Store Connect build limit must be between 1 and 200.");
    }
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

    const { data } = await this.request("GET", `/v1/builds?${query}`);
    return parseAscItems(data).map((build) => {
      const result = ascBuildItemSchema.safeParse(build);
      if (!result.success) {
        throw new Error("App Store Connect returned invalid build metadata.");
      }
      return {
        id: result.data.id,
        version: result.data.attributes.version ?? "?",
        processingState: result.data.attributes.processingState ?? "UNKNOWN",
        uploadedDate: result.data.attributes.uploadedDate ?? "",
      };
    });
  }

  /**
   * Sets TestFlight "What to Test" notes for a build.
   * POST first; on 409 (localization already exists) finds it and PATCHes.
   */
  async setWhatToTest(buildId: string, whatsNew: string, locale = "en-US"): Promise<void> {
    validateAscResourceId(buildId, "build identifier");
    if (Buffer.byteLength(whatsNew, "utf8") > 4000 || whatsNew.includes("\0")) {
      throw new Error("App Store Connect What to Test text exceeds the size limit.");
    }
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
      throw new Error("Invalid App Store Connect locale.");
    }
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
    const { data } = await this.request(
      "GET",
      `/v1/builds/${encodeURIComponent(buildId)}/betaBuildLocalizations`
    );
    const localizations = parseAscItems(data, 100).map((item) => {
      const result = ascLocalizationItemSchema.safeParse(item);
      if (!result.success) {
        throw new Error("App Store Connect returned invalid localization metadata.");
      }
      return result.data;
    });
    const existing = localizations.find((item) => item.attributes?.locale === locale)
      ?? localizations[0];
    if (!existing) {
      throw new Error(`App Store Connect: no betaBuildLocalization found for build "${buildId}"`);
    }
    const localizationId = existing.id;
    await this.request("PATCH", `/v1/betaBuildLocalizations/${encodeURIComponent(localizationId)}`, {
      data: {
        type: "betaBuildLocalizations",
        id: localizationId,
        attributes: { whatsNew },
      },
    });
  }

  /** Lists TestFlight beta groups for an app. */
  async getBetaGroups(appId: string): Promise<AscBetaGroup[]> {
    validateAscResourceId(appId, "application identifier");
    const { data } = await this.request(
      "GET",
      `/v1/betaGroups?filter[app]=${encodeURIComponent(appId)}`
    );
    return parseAscItems(data).map((group) => {
      const result = ascBetaGroupItemSchema.safeParse(group);
      if (!result.success) {
        throw new Error("App Store Connect returned invalid beta group metadata.");
      }
      return {
        id: result.data.id,
        name: result.data.attributes.name ?? "?",
        isInternal: result.data.attributes.isInternalGroup,
      };
    });
  }

  /** Assigns a build to a beta group (expects 204 No Content). */
  async addBuildToGroup(groupId: string, buildId: string): Promise<void> {
    validateAscResourceId(groupId, "beta group identifier");
    validateAscResourceId(buildId, "build identifier");
    await this.request("POST", `/v1/betaGroups/${encodeURIComponent(groupId)}/relationships/builds`, {
      data: [{ type: "builds", id: buildId }],
    });
  }

  /** Submits a build for external TestFlight beta review. */
  async submitForBetaReview(buildId: string): Promise<void> {
    validateAscResourceId(buildId, "build identifier");
    await this.request("POST", "/v1/betaAppReviewSubmissions", {
      data: {
        type: "betaAppReviewSubmissions",
        relationships: { build: { data: { type: "builds", id: buildId } } },
      },
    });
  }

  /** Marks a build as exempt from export-compliance encryption review. */
  async setEncryptionExempt(buildId: string, exempt = true): Promise<void> {
    validateAscResourceId(buildId, "build identifier");
    await this.request("PATCH", `/v1/builds/${encodeURIComponent(buildId)}`, {
      data: {
        type: "builds",
        id: buildId,
        attributes: { usesNonExemptEncryption: !exempt },
      },
    });
  }
}
