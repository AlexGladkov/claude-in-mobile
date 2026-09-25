import { GoogleAuth } from "google-auth-library";
import { Readable } from "stream";
import { z } from "zod";
import { readPrivateFileSync } from "../utils/private-storage.js";
import { AbstractStoreClient } from "./base-client.js";
import { validatePackageName } from "../utils/sanitize.js";
import { validateStoreArtifact, type ValidatedStoreArtifact } from "./upload-path.js";

const BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const UPLOAD_BASE = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
const SCOPES = ["https://www.googleapis.com/auth/androidpublisher"];

interface EditState {
  editId: string;
  versionCode?: number;
  releaseNotes: Array<{ language: string; text: string }>;
}

interface TrackRelease {
  versionCodes?: string[];
  status: string;
  userFraction?: number;
  releaseNotes?: Array<{ language: string; text: string }>;
}

interface TrackData {
  releases?: TrackRelease[];
}

function validateUploadUrl(value: string): void {
  if (value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Upload initiation returned an invalid URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Upload initiation returned an invalid URL");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || (url.port !== "" && url.port !== "443")
    || url.username !== ""
    || url.password !== ""
    || (host !== "googleapis.com" && !host.endsWith(".googleapis.com"))
  ) {
    throw new Error("Upload initiation returned an untrusted URL");
  }
}
function validateTrack(track: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(track)) {
    throw new Error("Invalid Google Play track.");
  }
}

function validateReleaseLanguage(language: string): void {
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw new Error("Invalid Google Play release language.");
  }
}
const googleTextSchema = z.string().min(1).max(1024).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "text contains control characters",
);
const googleStatusSchema = z.string().min(1).max(64).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "status contains control characters",
);
const googleReleaseNoteSchema = z.object({
  language: z.string().min(1).max(64),
  text: z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") <= 50 * 1024,
    "release note exceeds the size limit",
  ),
}).passthrough();
const googleTrackReleaseSchema = z.object({
  versionCodes: z.array(z.string().regex(/^\d{1,20}$/)).max(100).optional(),
  userFraction: z.number().finite().min(0).max(1).optional(),
  releaseNotes: z.array(googleReleaseNoteSchema).max(100).optional(),
  status: googleStatusSchema,
}).passthrough();
const googleTrackDataSchema = z.object({
  releases: z.array(googleTrackReleaseSchema).max(100).optional(),
}).passthrough();
const googleServiceAccountSchema = z.object({
  client_email: z.string().email().max(320),
  private_key: z.string().min(1).max(1024 * 1024),
}).passthrough();

const googleEditResponseSchema = z.object({
  id: googleTextSchema,
}).passthrough();
const googleUploadResponseSchema = z.object({
  versionCode: z.number().int().safe().positive(),
}).passthrough();

function parseEditId(value: unknown): string {
  const result = googleEditResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Google Play returned an invalid edit identifier.");
  }
  return encodeURIComponent(result.data.id);
}
function parseTrackData(value: unknown): TrackData {
  const result = googleTrackDataSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Google Play returned invalid track data.");
  }
  return result.data;
}

function parseServiceAccountCredentials(value: string): z.infer<typeof googleServiceAccountSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Google Play service account credentials are not valid JSON.");
  }
  const result = googleServiceAccountSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Google Play service account credentials are invalid.");
  }
  return result.data;
}

function buildAuth(): GoogleAuth {
  const keyFile = process.env.GOOGLE_PLAY_KEY_FILE;
  const keyContent = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (keyFile) {
    try {
      if (keyFile.length > 4096 || keyFile.includes("\0")) {
        throw new Error("GOOGLE_PLAY_KEY_FILE is invalid.");
      }
      const credentials = parseServiceAccountCredentials(
        readPrivateFileSync(keyFile, 1024 * 1024, "Google Play key file").toString("utf8"),
      );
      return new GoogleAuth({ credentials, scopes: SCOPES });
    } catch (error) {
      if (!keyContent) throw error;
    }
  }
  if (keyContent) {
    if (Buffer.byteLength(keyContent, "utf8") > 1024 * 1024) {
      throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON exceeds the size limit.");
    }
    return new GoogleAuth({
      credentials: parseServiceAccountCredentials(keyContent),
      scopes: SCOPES,
    });
  }
  // Will fail on first use with a clear message.
  return new GoogleAuth({ scopes: SCOPES });
}

export class GooglePlayClient extends AbstractStoreClient {
  private auth: GoogleAuth | undefined;
  private activeEdits = new Map<string, EditState>();

  protected get apiErrorPrefix(): string {
    return "Google Play API";
  }

  private async token(): Promise<string> {
    const auth = this.auth ??= buildAuth();
    const client = await auth.getClient();
    const res = await client.getAccessToken();
    if (!res.token) {
      throw new Error(
        "Google Play: failed to get access token. Set GOOGLE_PLAY_KEY_FILE or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON."
      );
    }
    return res.token;
  }

  private async ensureEdit(packageName: string): Promise<EditState> {
    validatePackageName(packageName);
    const existing = this.activeEdits.get(packageName);
    if (existing) return existing;

    const token = await this.token();
    const data = await this.api(
      "POST",
      `${BASE}/applications/${packageName}/edits`,
      token
    );
    const state: EditState = {
      editId: parseEditId(data),
      releaseNotes: [],
    };
    this.activeEdits.set(packageName, state);
    return state;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async upload(packageName: string, filePath: string): Promise<{ versionCode: number }> {
    return this.withPackageMutation(packageName, async () => {
      validatePackageName(packageName);
      let artifact: ValidatedStoreArtifact | undefined;
      try {
        const boundArtifact = await validateStoreArtifact(filePath, "android");
        artifact = boundArtifact;
        const token = await this.token();
        const state = await this.ensureEdit(packageName);
        const type = boundArtifact.path.toLowerCase().endsWith(".aab") ? "bundles" : "apks";
        const fileSize = boundArtifact.size;

        // Step 1: initiate resumable upload — get upload URL from Location header
        const initiateRes = await this.fetchWithTimeout(
          `${UPLOAD_BASE}/applications/${packageName}/edits/${state.editId}/${type}?uploadType=resumable`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Upload-Content-Type": "application/octet-stream",
              "X-Upload-Content-Length": String(fileSize),
              "Content-Type": "application/json",
              "Content-Length": "0",
            },
          }
        );

        if (!initiateRes.ok) {
          await initiateRes.body?.cancel();
          throw new Error(`Upload initiation failed with HTTP ${initiateRes.status}.`);
        }
        const uploadUrl = initiateRes.headers.get("location");
        if (!uploadUrl) {
          throw new Error("Upload initiation response missing Location header");
        }
        validateUploadUrl(uploadUrl);

        // Step 2: stream the already-open validated descriptor — no full file in memory
        const uploadRes = await this.fetchWithTimeout(uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(fileSize),
          },
          duplex: "half" as const,
          body: Readable.toWeb(boundArtifact.stream),
        }, 10 * 60_000);

        if (!uploadRes.ok) {
          await uploadRes.body?.cancel();
          throw new Error(`Upload failed with HTTP ${uploadRes.status}.`);
        }
        const uploadResult = googleUploadResponseSchema.safeParse(
          await this.readJson(uploadRes),
        );
        if (!uploadResult.success) {
          throw new Error("Google Play returned an invalid version code.");
        }
        const { versionCode } = uploadResult.data;
        state.versionCode = versionCode;
        return { versionCode };
      } finally {
        await artifact?.close();
      }
    });
  }

  async setReleaseNotes(packageName: string, language: string, text: string): Promise<void> {
    await this.withPackageMutation(packageName, async () => {
      validatePackageName(packageName);
      validateReleaseLanguage(language);
      if (Buffer.byteLength(text, "utf8") > 50 * 1024 || text.includes("\0")) {
        throw new Error("Google Play release notes exceed the size limit.");
      }
      const state = this.activeEdits.get(packageName);
      if (!state) {
        throw new Error(`No active release for "${packageName}". Call store_upload first.`);
      }
      const idx = state.releaseNotes.findIndex(n => n.language === language);
      if (idx >= 0) {
        state.releaseNotes[idx].text = text;
      } else {
        state.releaseNotes.push({ language, text });
      }
    });
  }

  async submit(packageName: string, track: string, rollout: number): Promise<void> {
    await this.withPackageMutation(packageName, async () => {
      validatePackageName(packageName);
      validateTrack(track);
      if (!Number.isFinite(rollout) || rollout <= 0 || rollout > 1) {
        throw new Error("Google Play rollout must be greater than 0 and at most 1.");
      }
      const state = this.activeEdits.get(packageName);
      if (!state) {
        throw new Error(`No active release for "${packageName}". Call store_upload first.`);
      }
      if (!state.versionCode) {
        throw new Error(`No version code for "${packageName}". Call store_upload first.`);
      }

      const token = await this.token();
      const isPartial = rollout < 1.0;

      await this.api("PUT", `${BASE}/applications/${packageName}/edits/${state.editId}/tracks/${track}`, token, {
        track,
        releases: [{
          versionCodes: [String(state.versionCode)],
          status: isPartial ? "inProgress" : "completed",
          ...(isPartial && { userFraction: rollout }),
          releaseNotes: state.releaseNotes.map(n => ({ language: n.language, text: n.text })),
        }],
      });

      await this.api("POST", `${BASE}/applications/${packageName}/edits/${state.editId}:commit`, token);
      this.activeEdits.delete(packageName);
    });
  }

  async promote(packageName: string, fromTrack: string, toTrack: string): Promise<void> {
    await this.withPackageMutation(packageName, async () => {
      validatePackageName(packageName);
      validateTrack(fromTrack);
      validateTrack(toTrack);
      const token = await this.token();
      const editData = await this.api(
        "POST", `${BASE}/applications/${packageName}/edits`, token
      );
      const editId = parseEditId(editData);

      try {
        const trackData = parseTrackData(await this.api(
          "GET", `${BASE}/applications/${packageName}/edits/${editId}/tracks/${fromTrack}`, token
        ));
        const release = trackData.releases?.[0];
        if (!release?.versionCodes?.length) {
          throw new Error(`No releases found on track "${fromTrack}"`);
        }

        await this.api("PUT", `${BASE}/applications/${packageName}/edits/${editId}/tracks/${toTrack}`, token, {
          track: toTrack,
          releases: [{
            versionCodes: release.versionCodes,
            status: "completed",
            releaseNotes: release.releaseNotes ?? [],
          }],
        });

        await this.api("POST", `${BASE}/applications/${packageName}/edits/${editId}:commit`, token);
      } catch (err) {
        await this.api("DELETE", `${BASE}/applications/${packageName}/edits/${editId}`, token).catch(() => {});
        throw err;
      }
    });
  }

  async getReleases(packageName: string, track?: string): Promise<string> {
    validatePackageName(packageName);
    if (track !== undefined) validateTrack(track);
    const token = await this.token();
    const editData = await this.api(
      "POST", `${BASE}/applications/${packageName}/edits`, token
    );
    const editId = parseEditId(editData);

    try {
      const tracks = track ? [track] : ["internal", "alpha", "beta", "production"];
      const lines: string[] = [];

      for (const t of tracks) {
        try {
          const data = parseTrackData(await this.api(
            "GET", `${BASE}/applications/${packageName}/edits/${editId}/tracks/${t}`, token
          ));
          lines.push(this.formatTrack(t, data.releases ?? []));
        } catch (err) {
          if (track) throw err; // Re-throw if specific track was requested
          // Otherwise silently skip empty tracks
        }
      }

      return lines.join("\n").trim() || "No releases found";
    } finally {
      await this.api("DELETE", `${BASE}/applications/${packageName}/edits/${editId}`, token).catch(() => {});
    }
  }

  async haltRollout(packageName: string, track: string): Promise<void> {
    await this.withPackageMutation(packageName, async () => {
      validatePackageName(packageName);
      validateTrack(track);
      const token = await this.token();
      const editData = await this.api(
        "POST", `${BASE}/applications/${packageName}/edits`, token
      );
      const editId = parseEditId(editData);

      try {
        const data = parseTrackData(await this.api(
          "GET", `${BASE}/applications/${packageName}/edits/${editId}/tracks/${track}`, token
        ));
        const release = data.releases?.[0];
        if (!release) throw new Error(`No active release on track "${track}"`);
        if (release.status !== "inProgress") {
          throw new Error(`Track "${track}" is not in staged rollout (status: ${release.status})`);
        }

        await this.api("PUT", `${BASE}/applications/${packageName}/edits/${editId}/tracks/${track}`, token, {
          track,
          releases: [{ versionCodes: release.versionCodes, status: "halted" }],
        });

        await this.api("POST", `${BASE}/applications/${packageName}/edits/${editId}:commit`, token);
      } catch (err) {
        await this.api("DELETE", `${BASE}/applications/${packageName}/edits/${editId}`, token).catch(() => {});
        throw err;
      }
    });
  }

  async discard(packageName: string): Promise<void> {
    await this.withPackageMutation(packageName, async () => {
      validatePackageName(packageName);
      const state = this.activeEdits.get(packageName);
      if (!state) {
        throw new Error(`No active release draft for "${packageName}"`);
      }
      const token = await this.token();
      await this.api("DELETE", `${BASE}/applications/${packageName}/edits/${state.editId}`, token).catch(() => {});
      this.activeEdits.delete(packageName);
    });
  }

  // ── Formatting ──────────────────────────────────────────────────────────────

  private formatTrack(track: string, releases: TrackRelease[]): string {
    if (releases.length === 0) return `${track}: (empty)`;
    const r = releases[0];
    const versions = r.versionCodes?.join(", ") ?? "?";
    const fraction = r.userFraction !== undefined ? ` (${(r.userFraction * 100).toFixed(0)}% rollout)` : "";
    return `${track}: v${versions} — ${r.status}${fraction}`;
  }
}
