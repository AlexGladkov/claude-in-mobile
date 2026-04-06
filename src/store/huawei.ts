import { existsSync, createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import type { StoreClient, UploadResult } from "./store-client.js";

const OAUTH_URL = "https://connect-api.cloud.huawei.com/api/oauth2/v1/token";
const BASE = "https://connect-api.cloud.huawei.com/api/publish/v2";
const UPLOAD_KIT_BASE = "https://connect-api.cloud.huawei.com/api/publishingkit/v1";

interface TokenCache {
  token: string;
  expiresAt: number;
}

interface AppIdResponse {
  ret: { code: number; msg: string };
  appIds?: Array<{ appId: string; packageName: string }>;
}

interface UploadUrlResponse {
  ret: { code: number; msg: string };
  uploadUrl?: string;
  authCode?: string;
}

interface UploadFileResponse {
  result: { resultCode: number; resultMsg: string };
  fileInfoList?: Array<{ fileId: string; fileName: string; size: number }>;
}

interface AppInfoResponse {
  ret: { code: number; msg: string };
  appInfo?: {
    packageName: string;
    versionCode: number;
    releaseState: number;
  };
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
  if (!clientId || !clientSecret) {
    throw new Error(
      "Huawei AppGallery: missing credentials. Set HUAWEI_CLIENT_ID and HUAWEI_CLIENT_SECRET environment variables."
    );
  }
  return { clientId, clientSecret };
}

export class HuaweiAppGalleryClient implements StoreClient {
  private tokenCache: TokenCache | null = null;
  private appIdCache = new Map<string, string>();
  private drafts = new Map<string, DraftState>();

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

    const res = await fetch(OAUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Huawei OAuth failed ${res.status}: ${text}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    if (!data.access_token) {
      throw new Error("Huawei OAuth: no access_token in response");
    }

    this.tokenCache = {
      token: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    };
    return this.tokenCache.token;
  }

  // ── API helpers ──────────────────────────────────────────────────────────────

  private async api<T>(method: string, url: string, token: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Huawei API ${res.status} ${method} ${url}: ${text}`);
    }
    if (res.status === 204 || res.headers.get("content-length") === "0") return {} as T;
    return res.json() as Promise<T>;
  }

  private async getAppId(packageName: string, token: string): Promise<string> {
    const cached = this.appIdCache.get(packageName);
    if (cached) return cached;

    const data = await this.api<AppIdResponse>(
      "GET",
      `${BASE}/app-id-list?packageName=${encodeURIComponent(packageName)}`,
      token
    );

    if (data.ret.code !== 0) {
      throw new Error(`Huawei: failed to get appId for "${packageName}": ${data.ret.msg}`);
    }

    const entry = data.appIds?.[0];
    if (!entry) {
      throw new Error(`Huawei: no appId found for package "${packageName}"`);
    }

    this.appIdCache.set(packageName, entry.appId);
    return entry.appId;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async upload(packageName: string, filePath: string): Promise<UploadResult> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const token = await this.getToken();
    const appId = await this.getAppId(packageName, token);

    const ext = filePath.toLowerCase().endsWith(".aab") ? "AAB" : "APK";
    const fileName = filePath.split("/").pop() ?? filePath;
    const { size: fileSize } = await stat(filePath);

    // Step 1: Get upload URL and authCode
    const urlData = await this.api<UploadUrlResponse>(
      "GET",
      `${UPLOAD_KIT_BASE}/files/uploadUrl?appId=${appId}&fileType=${ext}&releaseType=1`,
      token
    );

    if (urlData.ret.code !== 0) {
      throw new Error(`Huawei: failed to get upload URL: ${urlData.ret.msg}`);
    }
    if (!urlData.uploadUrl || !urlData.authCode) {
      throw new Error("Huawei: upload URL response missing uploadUrl or authCode");
    }

    // Step 2: Upload file via multipart/form-data
    const formData = new FormData();
    const webStream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
    const blob = new Blob([await streamToBuffer(webStream)], { type: "application/octet-stream" });
    formData.append("file", blob, fileName);
    formData.append("token", urlData.authCode);

    const uploadRes = await fetch(urlData.uploadUrl, {
      method: "POST",
      body: formData,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(`Huawei: file upload failed ${uploadRes.status}: ${text}`);
    }

    const uploadData = await uploadRes.json() as UploadFileResponse;
    if (uploadData.result.resultCode !== 0) {
      throw new Error(`Huawei: file upload error: ${uploadData.result.resultMsg}`);
    }

    const fileInfo = uploadData.fileInfoList?.[0];
    if (!fileInfo) {
      throw new Error("Huawei: upload response missing fileInfoList");
    }

    // Step 3: Attach uploaded file to app
    await this.api(
      "PUT",
      `${BASE}/app-file-info?appId=${appId}`,
      token,
      {
        fileType: 5,
        files: [{
          fileId: fileInfo.fileId,
          fileName: fileInfo.fileName,
          fileDestUrl: urlData.uploadUrl,
          size: fileSize,
        }],
      }
    );

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
    const token = await this.getToken();
    const appId = await this.getAppId(packageName, token);

    // Submit the app for review/publishing
    const data = await this.api<{ ret: { code: number; msg: string } }>(
      "POST",
      `${BASE}/app-submit?appId=${appId}`,
      token
    );

    if (data.ret.code !== 0) {
      throw new Error(`Huawei: submit failed: ${data.ret.msg}`);
    }

    this.drafts.delete(packageName);
  }

  async getReleases(packageName: string): Promise<string> {
    const token = await this.getToken();
    const appId = await this.getAppId(packageName, token);

    const data = await this.api<AppInfoResponse>(
      "GET",
      `${BASE}/app-info?appId=${appId}`,
      token
    );

    if (data.ret.code !== 0) {
      throw new Error(`Huawei: getReleases failed: ${data.ret.msg}`);
    }

    if (!data.appInfo) {
      return `${packageName}: no release info available`;
    }

    const { versionCode, releaseState } = data.appInfo;
    const statusLabel = formatReleaseState(releaseState);
    return `${packageName}: v${versionCode} — ${statusLabel}`;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

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
