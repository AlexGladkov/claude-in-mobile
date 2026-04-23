import { GoogleAuth } from "google-auth-library";
import { existsSync, createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { AbstractStoreClient } from "./base-client.js";
import { sanitizeErrorMessage } from "../utils/sanitize.js";

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

function buildAuth(): GoogleAuth {
  const keyFile = process.env.GOOGLE_PLAY_KEY_FILE;
  const keyContent = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;

  if (keyFile && existsSync(keyFile)) {
    return new GoogleAuth({ keyFile, scopes: SCOPES });
  }
  if (keyContent) {
    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(keyContent);
    } catch {
      throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON. Check the environment variable.");
    }
    return new GoogleAuth({ credentials, scopes: SCOPES });
  }
  // Will fail on first use with a clear message
  return new GoogleAuth({ scopes: SCOPES });
}

export class GooglePlayClient extends AbstractStoreClient {
  private auth = buildAuth();
  private activeEdits = new Map<string, EditState>();

  protected get apiErrorPrefix(): string {
    return "Google Play API";
  }

  private async token(): Promise<string> {
    const client = await this.auth.getClient();
    const res = await client.getAccessToken();
    if (!res.token) {
      throw new Error(
        "Google Play: failed to get access token. Set GOOGLE_PLAY_KEY_FILE or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON."
      );
    }
    return res.token;
  }

  private async ensureEdit(packageName: string): Promise<EditState> {
    const existing = this.activeEdits.get(packageName);
    if (existing) return existing;

    const token = await this.token();
    const data = await this.api<{ id: string }>(
      "POST",
      `${BASE}/applications/${packageName}/edits`,
      token
    );
    const state: EditState = { editId: data.id, releaseNotes: [] };
    this.activeEdits.set(packageName, state);
    return state;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async upload(packageName: string, filePath: string): Promise<{ versionCode: number }> {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    const token = await this.token();
    const state = await this.ensureEdit(packageName);
    const type = filePath.endsWith(".aab") ? "bundles" : "apks";
    const { size: fileSize } = await stat(filePath);

    // Step 1: initiate resumable upload — get upload URL from Location header
    const initiateRes = await fetch(
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
      const text = sanitizeErrorMessage((await initiateRes.text()).slice(0, 200));
      throw new Error(`Upload initiation failed ${initiateRes.status}: ${text}`);
    }

    const uploadUrl = initiateRes.headers.get("location");
    if (!uploadUrl) {
      throw new Error("Upload initiation response missing Location header");
    }

    // Step 2: stream file to upload URL — no full file in memory
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(fileSize),
      },
      // @ts-ignore — duplex required for streaming body in Node.js fetch
      duplex: "half",
      body: Readable.toWeb(createReadStream(filePath)),
    });

    if (!uploadRes.ok) {
      const text = sanitizeErrorMessage((await uploadRes.text()).slice(0, 200));
      throw new Error(`Upload failed ${uploadRes.status}: ${text}`);
    }

    const data = await uploadRes.json() as { versionCode: number };
    state.versionCode = data.versionCode;
    return { versionCode: data.versionCode };
  }

  async setReleaseNotes(packageName: string, language: string, text: string): Promise<void> {
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
  }

  async submit(packageName: string, track: string, rollout: number): Promise<void> {
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
  }

  async promote(packageName: string, fromTrack: string, toTrack: string): Promise<void> {
    const token = await this.token();
    const { id: editId } = await this.api<{ id: string }>(
      "POST", `${BASE}/applications/${packageName}/edits`, token
    );

    try {
      const trackData = await this.api<TrackData>(
        "GET", `${BASE}/applications/${packageName}/edits/${editId}/tracks/${fromTrack}`, token
      );
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
  }

  async getReleases(packageName: string, track?: string): Promise<string> {
    const token = await this.token();
    const { id: editId } = await this.api<{ id: string }>(
      "POST", `${BASE}/applications/${packageName}/edits`, token
    );

    try {
      const tracks = track ? [track] : ["internal", "alpha", "beta", "production"];
      const lines: string[] = [];

      for (const t of tracks) {
        try {
          const data = await this.api<TrackData>(
            "GET", `${BASE}/applications/${packageName}/edits/${editId}/tracks/${t}`, token
          );
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
    const token = await this.token();
    const { id: editId } = await this.api<{ id: string }>(
      "POST", `${BASE}/applications/${packageName}/edits`, token
    );

    try {
      const data = await this.api<TrackData>(
        "GET", `${BASE}/applications/${packageName}/edits/${editId}/tracks/${track}`, token
      );
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
  }

  async discard(packageName: string): Promise<void> {
    const state = this.activeEdits.get(packageName);
    if (!state) {
      throw new Error(`No active release draft for "${packageName}"`);
    }
    const token = await this.token();
    await this.api("DELETE", `${BASE}/applications/${packageName}/edits/${state.editId}`, token).catch(() => {});
    this.activeEdits.delete(packageName);
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
