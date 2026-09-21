import { existsSync, openAsBlob } from "node:fs";
import { basename } from "node:path";
import { createSign } from "crypto";
import { z } from "zod";
import type { StoreClient, UploadResult } from "./store-client.js";
import { AbstractStoreClient } from "./base-client.js";
import { validatePackageName } from "../utils/sanitize.js";

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


interface ReleaseNoteEntry {
  language: string;
  text: string;
}

interface DraftState {
  versionId: number;
  releaseNotes: ReleaseNoteEntry[];
}
const ruStoreCodeSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const ruStoreRecordSchema = z.record(z.string(), z.unknown());
const ruStoreResponseSchema = z.object({
  code: ruStoreCodeSchema,
  message: z.string().max(4096).optional(),
  body: z.unknown().optional(),
}).passthrough();
const ruStoreCredentialsSchema = z.object({
  companyId: z.string().min(1).max(256),
  keyId: z.string().min(1).max(256),
  privateKey: z.string().min(1).max(1024 * 1024),
}).strict();
const ruStoreAuthBodySchema = z.object({
  jwtToken: z.string().min(1).max(64 * 1024),
  ttl: z.number().finite().positive().max(86_400),
}).passthrough();
const ruStoreDraftBodySchema = z.object({
  versionId: z.number().int().safe().positive(),
}).passthrough();
const ruStoreVersionSchema = z.object({
  versionId: z.number().int().safe(),
  versionCode: z.number().int().safe().optional(),
  versionName: z.string().max(256).optional(),
  appStatus: z.string().max(128).optional(),
  publishType: z.string().max(128).optional(),
}).passthrough();
const ruStoreVersionListSchema = z.array(ruStoreVersionSchema).max(10_000);

function responseRecord(value: unknown): Record<string, unknown> {
  const result = ruStoreRecordSchema.safeParse(value);
  if (!result.success) {
    throw new Error("RuStore returned an invalid response.");
  }
  return result.data;
}

function responseCode(value: unknown): { record: Record<string, unknown>; code: string } {
  const result = ruStoreResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error("RuStore returned an invalid response.");
  }
  return { record: result.data, code: result.data.code };
}

function loadCredentials(): RuStoreCredentials {
  const keyJson = process.env.RUSTORE_KEY_JSON;
  // Try JSON config first
  if (keyJson) {
    if (Buffer.byteLength(keyJson, "utf8") > 1024 * 1024) {
      throw new Error("RuStore: RUSTORE_KEY_JSON exceeds the size limit");
    }
    try {
      const result = ruStoreCredentialsSchema.safeParse(JSON.parse(keyJson));
      if (!result.success) throw new Error("invalid credentials");
      return result.data;
    } catch {
      throw new Error("RuStore: RUSTORE_KEY_JSON is not valid credentials JSON");
    }
  }

  // Try individual env vars
  const companyId = process.env.RUSTORE_COMPANY_ID;
  const keyId = process.env.RUSTORE_KEY_ID;
  const privateKey = process.env.RUSTORE_PRIVATE_KEY;

  const result = ruStoreCredentialsSchema.safeParse({ companyId, keyId, privateKey });
  if (result.success) {
    return result.data;
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

export class RuStoreClient extends AbstractStoreClient implements StoreClient {
  private tokenCache: TokenCache | null = null;
  private drafts = new Map<string, DraftState>();

  protected get apiErrorPrefix(): string {
    return "RuStore API";
  }

  /** RuStore uses "Public-Token" header instead of "Authorization: Bearer" */
  protected override authHeader(token: string): Record<string, string> {
    return { "Public-Token": token };
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────

  private async getToken(): Promise<string> {
    const now = Date.now();
    // Refresh 60 seconds before expiry
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token;
    }

    const credentials = loadCredentials();
    const jwtToken = createJwt(credentials);

    const res = await this.fetchWithTimeout(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jwtToken }),
    });

    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`RuStore auth failed with HTTP ${res.status}.`);
    }

    const { record: data, code } = responseCode(await this.readJson(res));
    if (code !== "OK") throw new Error(`RuStore auth failed with code ${code}.`);
    const authResult = ruStoreAuthBodySchema.safeParse(data.body);
    if (!authResult.success) {
      throw new Error("RuStore returned invalid authentication data.");
    }
    const authBody = authResult.data;
    this.tokenCache = {
      token: authBody.jwtToken,
      expiresAt: Date.now() + authBody.ttl * 1000,
    };
    return this.tokenCache.token;
  }

  private async createDraftVersion(packageName: string, token: string): Promise<number> {
    const { record: data, code } = responseCode(await this.api(
      "POST",
      `${BASE}/application/${encodeURIComponent(packageName)}/version`,
      token,
      { whatsNew: {} }
    ));
    if (code !== "OK") throw new Error(`RuStore draft creation failed with code ${code}.`);
    const bodyResult = ruStoreDraftBodySchema.safeParse(data.body);
    if (!bodyResult.success) {
      throw new Error("RuStore returned an invalid draft version ID.");
    }
    return bodyResult.data.versionId;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  async upload(packageName: string, filePath: string): Promise<UploadResult> {
    validatePackageName(packageName);
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const token = await this.getToken();
    const versionId = await this.createDraftVersion(packageName, token);

    const isAab = filePath.toLowerCase().endsWith(".aab");
    const uploadPath = isAab ? "aab" : "apk";
    const fileName = basename(filePath);

    const formData = new FormData();
    const blob = await openAsBlob(filePath, { type: "application/octet-stream" });
    formData.append("file", blob, fileName);

    const uploadUrl =
      `${BASE}/application/${encodeURIComponent(packageName)}/version/${versionId}/${uploadPath}` +
      `?servicesType=Unknown&isMainApk=true`;

    const res = await this.fetchWithTimeout(uploadUrl, {
      method: "POST",
      headers: {
        "Public-Token": token,
        // No Content-Type — let fetch set multipart boundary automatically
      },
      body: formData,
    }, 10 * 60_000);

    if (!res.ok) {
      await res.body?.cancel();
      await this.deleteDraft(packageName, versionId, token);
      throw new Error(`RuStore upload failed with HTTP ${res.status}.`);
    }

    const { code } = responseCode(await this.readJson(res));
    if (code !== "OK") {
      await this.deleteDraft(packageName, versionId, token);
      throw new Error(`RuStore upload failed with code ${code}.`);
    }

    this.drafts.set(packageName, { versionId, releaseNotes: [] });

    return { versionId: String(versionId) };
  }

  async setReleaseNotes(packageName: string, language: string, text: string): Promise<void> {
    validatePackageName(packageName);
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
      throw new Error("Invalid RuStore release language.");
    }
    if (Buffer.byteLength(text, "utf8") > 50 * 1024 || text.includes("\0")) {
      throw new Error("RuStore release notes exceed the size limit.");
    }
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
    validatePackageName(packageName);
    if (
      _options?.rollout !== undefined
      && (!Number.isFinite(_options.rollout) || _options.rollout !== 1)
    ) {
      throw new Error("RuStore does not support staged rollout.");
    }
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
      const patchData = await this.api(
        "PATCH",
        `${BASE}/application/${encodeURIComponent(packageName)}/version/${versionId}/publishing-settings`,
        token,
        { whatsNew }
      );
      const { code } = responseCode(patchData);
      if (code !== "OK") {
        throw new Error(`RuStore release notes update failed with code ${code}.`);
      }
    }

    // Submit for moderation
    const submitData = await this.api(
      "POST",
      `${BASE}/application/${encodeURIComponent(packageName)}/version/${versionId}/submit-for-moderation`,
      token
    );

    const { code } = responseCode(submitData);
    if (code !== "OK") {
      throw new Error(`RuStore submission failed with code ${code}.`);
    }

    this.drafts.delete(packageName);
  }

  async getReleases(packageName: string): Promise<string> {
    validatePackageName(packageName);
    const token = await this.getToken();

    const data = await this.api(
      "GET",
      `${BASE}/application/${encodeURIComponent(packageName)}/version`,
      token
    );

    const { record, code } = responseCode(data);
    if (code !== "OK") {
      throw new Error(`RuStore release listing failed with code ${code}.`);
    }
    const versionsResult = ruStoreVersionListSchema.safeParse(record.body);
    if (!versionsResult.success) {
      throw new Error("RuStore returned an invalid release list.");
    }

    if (versionsResult.data.length === 0) return `${packageName}: no versions found`;
    const lines = versionsResult.data.map((version) => {
      const versionName = version.versionName
        ?.replace(/[\u0000-\u001f\u007f]/g, "")
        .slice(0, 256);
      const versionCode = version.versionCode ?? "?";
      const status = version.appStatus
        ?.replace(/[\u0000-\u001f\u007f]/g, "")
        .slice(0, 128) ?? "unknown";
      const displayVersion = versionName
        ? `${versionName} (${versionCode})`
        : `versionId=${String(version.versionId)}`;
      return `  v${displayVersion} — ${status}`;
    });
    return `${packageName}:\n${lines.join("\n")}`;
  }

  async discard(packageName: string): Promise<void> {
    validatePackageName(packageName);
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
    const res = await this.fetchWithTimeout(
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

