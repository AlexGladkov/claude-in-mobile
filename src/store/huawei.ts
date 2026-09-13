import { existsSync, openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import type { StoreClient, UploadResult } from "./store-client.js";
import { AbstractStoreClient } from "./base-client.js";
import { validatePackageName } from "../utils/sanitize.js";

const OAUTH_URL = "https://connect-api.cloud.huawei.com/api/oauth2/v1/token";
const BASE = "https://connect-api.cloud.huawei.com/api/publish/v2";
const UPLOAD_KIT_BASE = "https://connect-api.cloud.huawei.com/api/publishingkit/v1";
const TRUSTED_UPLOAD_DOMAINS: Readonly<Record<string, true>> = Object.freeze({
  "huawei.com": true,
  "huaweicloud.com": true,
  "hicloud.com": true,
});
const huaweiIdSchema = z.string().min(1).max(4096).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "identifier contains control characters",
);
const huaweiResponseSchema = z.object({
  ret: z.object({
    code: z.number().int().safe(),
  }).passthrough(),
}).passthrough();
const huaweiOAuthSchema = z.object({
  access_token: z.string().min(1).max(64 * 1024),
  expires_in: z.number().finite().positive().max(7 * 86_400),
}).passthrough();
const huaweiUploadSchema = z.object({
  result: z.object({
    resultCode: z.number().int().safe(),
  }).passthrough(),
  fileInfoList: z.array(z.object({
    fileId: huaweiIdSchema,
    fileName: huaweiIdSchema,
  }).passthrough()).min(1).max(1000),
}).passthrough();
const huaweiAppIdsSchema = z.array(
  z.object({ appId: huaweiIdSchema }).passthrough(),
).min(1).max(1000);

interface TokenCache {
  token: string;
  expiresAt: number;
}


function validateUploadUrl(value: string): void {
  if (value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Huawei returned an invalid upload URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Huawei returned an invalid upload URL");
  }
  const host = url.hostname.toLowerCase();
  const trusted = Object.keys(TRUSTED_UPLOAD_DOMAINS)
    .some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (
    url.protocol !== "https:"
    || (url.port !== "" && url.port !== "443")
    || url.username !== ""
    || url.password !== ""
    || !trusted
  ) {
    throw new Error("Huawei returned an untrusted upload URL");
  }
}

interface ReleaseNoteEntry {
  language: string;
  text: string;
}

interface DraftState {
  fileId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
  releaseNotes: ReleaseNoteEntry[];
}

function buildCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.HUAWEI_CLIENT_ID;
  const clientSecret = process.env.HUAWEI_CLIENT_SECRET;
  if (
    !clientId || clientId.length > 1024
    || !clientSecret || clientSecret.length > 64 * 1024
  ) {
    throw new Error(
      "Huawei AppGallery: missing or invalid HUAWEI_CLIENT_ID/HUAWEI_CLIENT_SECRET credentials."
    );
  }
  return { clientId, clientSecret };
}
function parseHuaweiResponse(value: unknown, operation: string): Record<string, unknown> {
  const result = huaweiResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Huawei returned invalid data for ${operation}.`);
  }
  if (result.data.ret.code !== 0) {
    throw new Error(`Huawei rejected ${operation} (code ${result.data.ret.code}).`);
  }
  return result.data;
}

function parseHuaweiId(value: unknown, field: string): string {
  const result = huaweiIdSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Huawei returned an invalid ${field}.`);
  }
  return result.data;
}

export class HuaweiAppGalleryClient extends AbstractStoreClient implements StoreClient {
  private tokenCache: TokenCache | null = null;
  private appIdCache = new Map<string, string>();
  private drafts = new Map<string, DraftState>();

  protected get apiErrorPrefix(): string {
    return "Huawei API";
  }
  protected override authHeader(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      client_id: buildCredentials().clientId,
    };
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token;
    }

    const { clientId, clientSecret } = buildCredentials();
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });

    const res = await this.fetchWithTimeout(OAUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Huawei OAuth failed with HTTP ${res.status}.`);
    }

    const tokenResult = huaweiOAuthSchema.safeParse(await this.readJson(res));
    if (!tokenResult.success) {
      throw new Error("Huawei OAuth returned invalid token data.");
    }
    const data = tokenResult.data;

    this.tokenCache = {
      token: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };
    return this.tokenCache.token;
  }

  private async getAppId(packageName: string, token: string): Promise<string> {
    const cached = this.appIdCache.get(packageName);
    if (cached) return cached;

    const response = parseHuaweiResponse(await this.api(
      "GET",
      `${BASE}/app-id-list?packageName=${encodeURIComponent(packageName)}`,
      token
    ), "application lookup");
    const appIdsResult = huaweiAppIdsSchema.safeParse(response.appIds);
    if (!appIdsResult.success) {
      throw new Error(`Huawei: no appId found for package "${packageName}"`);
    }
    const appId = appIdsResult.data[0].appId;
    this.appIdCache.set(packageName, appId);
    return appId;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async upload(packageName: string, filePath: string): Promise<UploadResult> {
    validatePackageName(packageName);
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const token = await this.getToken();
    const appId = await this.getAppId(packageName, token);

    const ext = filePath.toLowerCase().endsWith(".aab") ? "AAB" : "APK";
    const fileName = basename(filePath);
    const { size: fileSize } = await stat(filePath);

    // Step 1: Get upload URL and authCode
    const urlData = parseHuaweiResponse(await this.api(
      "GET",
      `${UPLOAD_KIT_BASE}/files/uploadUrl?appId=${encodeURIComponent(appId)}&fileType=${ext}&releaseType=1`,
      token
    ), "upload session creation");
    const uploadUrl = parseHuaweiId(urlData.uploadUrl, "upload URL");
    const authCode = parseHuaweiId(urlData.authCode, "upload authorization");
    validateUploadUrl(uploadUrl);

    // Step 2: Upload file via multipart/form-data
    const formData = new FormData();
    const blob = await openAsBlob(filePath, { type: "application/octet-stream" });
    formData.append("file", blob, fileName);
    formData.append("token", authCode);

    const uploadRes = await this.fetchWithTimeout(uploadUrl, {
      method: "POST",
      body: formData,
    }, 10 * 60_000);

    if (!uploadRes.ok) {
      await uploadRes.body?.cancel();
      throw new Error(`Huawei file upload failed with HTTP ${uploadRes.status}.`);
    }

    const uploadResult = huaweiUploadSchema.safeParse(await this.readJson(uploadRes));
    if (!uploadResult.success) {
      throw new Error("Huawei returned an invalid upload response.");
    }
    if (uploadResult.data.result.resultCode !== 0) {
      throw new Error("Huawei rejected the uploaded file.");
    }
    const fileInfo = uploadResult.data.fileInfoList[0];

    // Step 3: Attach uploaded file to app
    parseHuaweiResponse(await this.api(
      "PUT",
      `${BASE}/app-file-info?appId=${encodeURIComponent(appId)}`,
      token,
      {
        fileType: 5,
        files: [{
          fileId: fileInfo.fileId,
          fileName: fileInfo.fileName,
          fileDestUrl: uploadUrl,
          size: fileSize,
        }],
      }
    ), "file attachment");

    // Store draft state for release notes and submit
    this.drafts.set(packageName, {
      fileId: fileInfo.fileId,
      fileName: fileInfo.fileName,
      fileSize,
      fileType: ext,
      releaseNotes: [],
    });

    return { versionId: fileInfo.fileId };
  }

  async setReleaseNotes(packageName: string, language: string, text: string): Promise<void> {
    validatePackageName(packageName);
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
      throw new Error("Invalid Huawei release language.");
    }
    if (Buffer.byteLength(text, "utf8") > 50 * 1024 || text.includes("\0")) {
      throw new Error("Huawei release notes exceed the size limit.");
    }
    const draft = this.drafts.get(packageName);
    if (!draft) {
      throw new Error(`Huawei: no active upload for "${packageName}". Call huawei_upload first.`);
    }
    const idx = draft.releaseNotes.findIndex(n => n.language === language);
    if (idx >= 0) {
      draft.releaseNotes[idx].text = text;
    } else {
      draft.releaseNotes.push({ language, text });
    }
  }

  async submit(packageName: string, _options?: { rollout?: number }): Promise<void> {
    validatePackageName(packageName);
    const token = await this.getToken();
    const appId = await this.getAppId(packageName, token);
    const draft = this.drafts.get(packageName);
    if (draft) {
      for (const note of draft.releaseNotes) {
        parseHuaweiResponse(await this.api(
          "PUT",
          `${BASE}/app-language-info?appId=${encodeURIComponent(appId)}`,
          token,
          { lang: note.language, newFeatures: note.text },
        ), "release notes update");
      }
    }

    // Submit the app for review/publishing
    parseHuaweiResponse(await this.api(
      "POST",
      `${BASE}/app-submit?appId=${encodeURIComponent(appId)}`,
      token
    ), "submission");

    this.drafts.delete(packageName);
  }

  async getReleases(packageName: string): Promise<string> {
    validatePackageName(packageName);
    const token = await this.getToken();
    const appId = await this.getAppId(packageName, token);

    const data = parseHuaweiResponse(await this.api(
      "GET",
      `${BASE}/app-info?appId=${encodeURIComponent(appId)}`,
      token
    ), "release lookup");

    const appInfo = data.appInfo;
    if (appInfo === undefined) {
      return `${packageName}: no release info available`;
    }
    if (
      typeof appInfo !== "object"
      || appInfo === null
      || Array.isArray(appInfo)
      || !Number.isSafeInteger(Reflect.get(appInfo, "versionCode"))
      || !Number.isSafeInteger(Reflect.get(appInfo, "releaseState"))
    ) {
      throw new Error("Huawei returned invalid release metadata.");
    }
    const versionCode = Reflect.get(appInfo, "versionCode") as number;
    const releaseState = Reflect.get(appInfo, "releaseState") as number;
    const statusLabel = formatReleaseState(releaseState);
    return `${packageName}: v${versionCode} — ${statusLabel}`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatReleaseState(state: number): string {
  const states: Record<number, string> = {
    1: "Draft",
    2: "Under review",
    3: "Published",
    4: "Rejected",
    5: "Removed",
    6: "Update in review",
    7: "Update published",
  };
  return states[state] ?? `Unknown (${state})`;
}
