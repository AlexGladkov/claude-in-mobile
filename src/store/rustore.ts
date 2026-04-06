import { existsSync, createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { createSign } from "crypto";
import type { StoreClient, UploadResult } from "./store-client.js";

const BASE = "https://public-api.rustore.ru/public/v1";
const AUTH_URL = "https://public-api.rustore.ru/public/auth";

interface RuStoreCredentials {
  companyId: string;
  keyId: string;
  privateKey: string;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

interface AuthResponse {
  code: string;
  body: {
    jwtToken: string;
    ttl: number;
  };
  message?: string;
}

interface CreateVersionResponse {
  code: string;
  body: {
    versionId: number;
  };
  message?: string;
}

interface VersionListResponse {
  code: string;
  body: Array<{
    versionId: number;
    versionCode?: number;
    versionName?: string;
    appStatus?: string;
    publishType?: string;
  }>;
  message?: string;
}

interface RuStoreApiResponse {
  code: string;
  message?: string;
  body?: unknown;
}

interface ReleaseNoteEntry {
  language: string;
  text: string;
}

interface DraftState {
  versionId: number;
  releaseNotes: ReleaseNoteEntry[];
}

function loadCredentials(): RuStoreCredentials {
  // Try JSON config first
  const keyJson = process.env.RUSTORE_KEY_JSON;
  if (keyJson) {
    try {
      const parsed = JSON.parse(keyJson) as RuStoreCredentials;
      if (parsed.companyId && parsed.keyId && parsed.privateKey) {
        return parsed;
      }
    } catch {
      throw new Error("RuStore: RUSTORE_KEY_JSON is not valid JSON");
    }
  }

  // Try individual env vars
  const companyId = process.env.RUSTORE_COMPANY_ID;
  const keyId = process.env.RUSTORE_KEY_ID;
  const privateKey = process.env.RUSTORE_PRIVATE_KEY;

  if (companyId && keyId && privateKey) {
    return { companyId, keyId, privateKey };
  }

  throw new Error(
    "RuStore: missing credentials. Set RUSTORE_KEY_JSON or (RUSTORE_COMPANY_ID + RUSTORE_KEY_ID + RUSTORE_PRIVATE_KEY) environment variables."
  );
}

function createJwt(credentials: RuStoreCredentials): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ keyId: credentials.keyId, timestamp: Date.now() })
  ).toString("base64url");

  const signingInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(credentials.privateKey, "base64url");

  return `${signingInput}.${signature}`;
}

export class RuStoreClient implements StoreClient {
  private tokenCache: TokenCache | null = null;
  private drafts = new Map<string, DraftState>();

  // ── Auth ─────────────────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    const now = Date.now();
    // Refresh 60 seconds before expiry
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token;
    }

    const credentials = loadCredentials();
    const jwtToken = createJwt(credentials);

    const res = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwtToken }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RuStore auth failed ${res.status}: ${text}`);
    }

    const data = await res.json() as AuthResponse;
    if (data.code !== "OK") {
      throw new Error(`RuStore auth error: ${data.message ?? data.code}`);
    }

    const ttlMs = data.body.ttl * 1000;
    this.tokenCache = {
      token: data.body.jwtToken,
      expiresAt: Date.now() + ttlMs,
    };
    return this.tokenCache.token;
  }

  // ── API helpers ──────────────────────────────────────────────────────────────

  private async api<T>(method: string, url: string, token: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: {
        "Public-Token": token,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RuStore API ${res.status} ${method} ${url}: ${text}`);
    }
    if (res.status === 204 || res.headers.get("content-length") === "0") return {} as T;
    return res.json() as Promise<T>;
  }

  private async createDraftVersion(packageName: string, token: string): Promise<number> {
    const data = await this.api<CreateVersionResponse>(
      "POST",
      `${BASE}/application/${encodeURIComponent(packageName)}/version`,
      token,
      { whatsNew: {} }
    );

    if (data.code !== "OK") {
      throw new Error(`RuStore: failed to create draft version: ${data.message ?? data.code}`);
    }

    return data.body.versionId;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async upload(packageName: string, filePath: string): Promise<UploadResult> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const token = await this.getToken();
    const versionId = await this.createDraftVersion(packageName, token);

    const isAab = filePath.toLowerCase().endsWith(".aab");
    const uploadPath = isAab ? "aab" : "apk";
    const { size: fileSize } = await stat(filePath);
    const fileName = filePath.split("/").pop() ?? filePath;

    const formData = new FormData();
    const webStream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
    const blob = new Blob([await streamToBuffer(webStream)], { type: "application/octet-stream" });
    formData.append("file", blob, fileName);

    const uploadUrl =
      `${BASE}/application/${encodeURIComponent(packageName)}/version/${versionId}/${uploadPath}` +
      `?servicesType=Unknown&isMainApk=true`;

    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Public-Token": token,
        // No Content-Type — let fetch set multipart boundary automatically
      },
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text();
      // Clean up orphaned draft
      await this.deleteDraft(packageName, versionId, token);
      throw new Error(`RuStore: APK/AAB upload failed ${res.status}: ${text}`);
    }

    const uploadData = await res.json() as RuStoreApiResponse;
    if (uploadData.code !== "OK") {
      await this.deleteDraft(packageName, versionId, token);
      throw new Error(`RuStore: upload error: ${uploadData.message ?? uploadData.code}`);
    }

    this.drafts.set(packageName, { versionId, releaseNotes: [] });
    void fileSize; // fileSize available if needed for logging

    return { versionId: String(versionId) };
  }

  async setReleaseNotes(packageName: string, language: string, text: string): Promise<void> {
    const draft = this.drafts.get(packageName);
    if (!draft) {
      throw new Error(`RuStore: no active upload for "${packageName}". Call rustore_upload first.`);
    }
    const idx = draft.releaseNotes.findIndex(n => n.language === language);
    if (idx >= 0) {
      draft.releaseNotes[idx].text = text;
    } else {
      draft.releaseNotes.push({ language, text });
    }
  }

  async submit(packageName: string, _options?: { rollout?: number }): Promise<void> {
    const draft = this.drafts.get(packageName);
    if (!draft) {
      throw new Error(`RuStore: no active upload for "${packageName}". Call rustore_upload first.`);
    }

    const token = await this.getToken();
    const { versionId, releaseNotes } = draft;

    // If there are release notes — patch them first
    if (releaseNotes.length > 0) {
      const whatsNew: Record<string, string> = {};
      for (const note of releaseNotes) {
        whatsNew[note.language] = note.text;
      }
      const patchData = await this.api<RuStoreApiResponse>(
        "PATCH",
        `${BASE}/application/${encodeURIComponent(packageName)}/version/${versionId}/publishing-settings`,
        token,
        { whatsNew }
      );
      if (patchData.code !== "OK") {
        throw new Error(`RuStore: failed to set release notes: ${patchData.message ?? patchData.code}`);
      }
    }

    // Submit for moderation
    const submitData = await this.api<RuStoreApiResponse>(
      "POST",
      `${BASE}/application/${encodeURIComponent(packageName)}/version/${versionId}/submit-for-moderation`,
      token
    );

    if (submitData.code !== "OK") {
      throw new Error(`RuStore: submit failed: ${submitData.message ?? submitData.code}`);
    }

    this.drafts.delete(packageName);
  }

  async getReleases(packageName: string): Promise<string> {
    const token = await this.getToken();

    const data = await this.api<VersionListResponse>(
      "GET",
      `${BASE}/application/${encodeURIComponent(packageName)}/version`,
      token
    );

    if (data.code !== "OK") {
      throw new Error(`RuStore: getReleases failed: ${data.message ?? data.code}`);
    }

    if (!data.body || data.body.length === 0) {
      return `${packageName}: no versions found`;
    }

    const lines = data.body.map(v => {
      const version = v.versionName ? `${v.versionName} (${v.versionCode ?? "?"})` : `versionId=${v.versionId}`;
      const status = v.appStatus ?? "unknown";
      return `  v${version} — ${status}`;
    });

    return `${packageName}:\n${lines.join("\n")}`;
  }

  async discard(packageName: string): Promise<void> {
    const draft = this.drafts.get(packageName);
    if (!draft) {
      throw new Error(`RuStore: no active draft for "${packageName}"`);
    }

    const token = await this.getToken();
    await this.deleteDraft(packageName, draft.versionId, token);
    this.drafts.delete(packageName);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async deleteDraft(packageName: string, versionId: number, token: string): Promise<void> {
    const res = await fetch(
      `${BASE}/application/${encodeURIComponent(packageName)}/version/${versionId}`,
      {
        method: "DELETE",
        headers: { "Public-Token": token },
      }
    );
    // Best-effort cleanup — do not throw
    if (!res.ok) {
      console.error(`RuStore: failed to delete draft version ${versionId} (${res.status})`);
    }
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
