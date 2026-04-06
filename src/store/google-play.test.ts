import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// GoogleAuth мокается как настоящий класс — иначе `new GoogleAuth()` падает
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getClient() {
      return Promise.resolve({
        getAccessToken: () => Promise.resolve({ token: "test-token" }),
      });
    }
  },
}));

import { GooglePlayClient } from "./google-play.js";

// ── helpers ──────────────────────────────────────────────────────────────────

type MockResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

function makeFetch(...responses: MockResponse[]) {
  let call = 0;
  return vi.fn().mockImplementation(() => {
    const r = responses[call++];
    if (!r) throw new Error(`Unexpected fetch call #${call}`);
    const isJson = typeof r.body === "object" && r.body !== null;
    const text = isJson ? JSON.stringify(r.body) : String(r.body ?? "");
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => (r.headers ?? {})[k.toLowerCase()] ?? null },
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(r.body),
    });
  });
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const EDIT    = { id: "edit-123" };
const UPLOAD  = { headers: { location: "https://upload.googleapis.com/resumable/abc" } };
const VERSION = { versionCode: 42 };
const OK      = {};

// ── tests ────────────────────────────────────────────────────────────────────

describe("GooglePlayClient", () => {
  let client: GooglePlayClient;
  let tmpFile: string;

  beforeEach(async () => {
    client = new GooglePlayClient();
    tmpFile = join(tmpdir(), `test-${Date.now()}.aab`);
    await writeFile(tmpFile, Buffer.alloc(1024, 0x42)); // 1 KB fake AAB
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (tmpFile) await rm(tmpFile, { force: true });
  });

  // ── upload ────────────────────────────────────────────────────────────────

  describe("upload", () => {
    it("uses resumable upload: initiate (POST) + stream (PUT)", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: EDIT },              // create edit
        { status: 200, body: {}, ...UPLOAD },     // initiate resumable
        { status: 200, body: VERSION },            // PUT stream
      ));

      const result = await client.upload("com.example.app", tmpFile);

      expect(result.versionCode).toBe(42);

      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(3);

      // initiate call: uploadType=resumable, NOT media
      const [initiateUrl, initiateOpts] = calls[1];
      expect(initiateUrl).toContain("uploadType=resumable");
      expect(initiateUrl).not.toContain("uploadType=media");
      expect(initiateOpts.headers["X-Upload-Content-Type"]).toBe("application/octet-stream");
      expect(initiateOpts.headers["X-Upload-Content-Length"]).toBe("1024");

      // stream call: goes to upload URL, duplex=half for streaming
      const [streamUrl, streamOpts] = calls[2];
      expect(streamUrl).toBe("https://upload.googleapis.com/resumable/abc");
      expect(streamOpts.method).toBe("PUT");
      expect(streamOpts.duplex).toBe("half");
    });

    it("throws if file does not exist", async () => {
      await expect(client.upload("com.example.app", "/nonexistent/path.aab"))
        .rejects.toThrow("File not found");
    });

    it("throws if upload initiation fails", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: EDIT },
        { status: 403, body: "Forbidden" },
      ));
      await expect(client.upload("com.example.app", tmpFile))
        .rejects.toThrow("Upload initiation failed 403");
    });

    it("throws if initiation response has no Location header", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: EDIT },
        { status: 200, body: {} },  // no Location
      ));
      await expect(client.upload("com.example.app", tmpFile))
        .rejects.toThrow("missing Location header");
    });

    it("throws if stream PUT fails", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: EDIT },
        { status: 200, body: {}, ...UPLOAD },
        { status: 500, body: "Internal Server Error" },
      ));
      await expect(client.upload("com.example.app", tmpFile))
        .rejects.toThrow("Upload failed 500");
    });

    it("uses /apks endpoint for .apk files", async () => {
      const apkFile = join(tmpdir(), `test-${Date.now()}.apk`);
      await writeFile(apkFile, Buffer.alloc(512));

      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: { id: "edit-apk" } },
        { status: 200, body: {}, headers: { location: "https://upload.googleapis.com/resumable/apk" } },
        { status: 200, body: { versionCode: 7 } },
      ));

      await client.upload("com.example.app", apkFile);

      const initiateUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
      expect(initiateUrl).toContain("/apks?");
      expect(initiateUrl).not.toContain("/bundles?");

      await rm(apkFile, { force: true });
    });
  });

  // ── submit ────────────────────────────────────────────────────────────────

  describe("submit", () => {
    it("throws if called without prior upload", async () => {
      await expect(client.submit("com.example.app", "internal", 1.0))
        .rejects.toThrow('No active release for "com.example.app"');
    });

    it("publishes to track with completed status at 100%", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: EDIT },
        { status: 200, body: {}, ...UPLOAD },
        { status: 200, body: VERSION },
        { status: 200, body: OK },   // PUT track
        { status: 200, body: OK },   // POST commit
      ));

      await client.upload("com.example.app", tmpFile);
      await client.submit("com.example.app", "internal", 1.0);

      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const [trackUrl, trackOpts] = calls[3];
      expect(trackUrl).toContain("/tracks/internal");
      expect(trackOpts.method).toBe("PUT");

      const body = JSON.parse(trackOpts.body);
      expect(body.releases[0].status).toBe("completed");
      expect(body.releases[0].versionCodes).toEqual(["42"]);
      expect(body.releases[0].userFraction).toBeUndefined();
    });

    it("sets inProgress + userFraction for staged rollout", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: EDIT },
        { status: 200, body: {}, ...UPLOAD },
        { status: 200, body: VERSION },
        { status: 200, body: OK },
        { status: 200, body: OK },
      ));

      await client.upload("com.example.app", tmpFile);
      await client.submit("com.example.app", "production", 0.1);

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[3][1].body
      );
      expect(body.releases[0].status).toBe("inProgress");
      expect(body.releases[0].userFraction).toBe(0.1);
    });
  });

  // ── setReleaseNotes ───────────────────────────────────────────────────────

  describe("setReleaseNotes", () => {
    it("throws if called without prior upload", async () => {
      await expect(client.setReleaseNotes("com.example.app", "en-US", "hello"))
        .rejects.toThrow('No active release for "com.example.app"');
    });

    it("deduplicates notes for the same language (last write wins)", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: EDIT },
        { status: 200, body: {}, ...UPLOAD },
        { status: 200, body: VERSION },
        { status: 200, body: OK },
        { status: 200, body: OK },
      ));

      await client.upload("com.example.app", tmpFile);
      await client.setReleaseNotes("com.example.app", "en-US", "First");
      await client.setReleaseNotes("com.example.app", "en-US", "Updated");
      await client.submit("com.example.app", "internal", 1.0);

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[3][1].body
      );
      const enNotes = body.releases[0].releaseNotes.filter((n: { language: string }) => n.language === "en-US");
      expect(enNotes).toHaveLength(1);
      expect(enNotes[0].text).toBe("Updated");
    });
  });

  // ── discard ───────────────────────────────────────────────────────────────

  describe("discard", () => {
    it("throws if no active draft", async () => {
      await expect(client.discard("com.example.app"))
        .rejects.toThrow("No active release draft");
    });

    it("sends DELETE and clears active state", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: { id: "edit-del" } },
        { status: 200, body: {}, ...UPLOAD },
        { status: 200, body: VERSION },
        { status: 204, body: "" },
      ));

      await client.upload("com.example.app", tmpFile);
      await client.discard("com.example.app");

      const [deleteUrl, deleteOpts] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[3];
      expect(deleteOpts.method).toBe("DELETE");
      expect(deleteUrl).toContain("/edits/edit-del");

      // state is cleared — submit should now throw
      await expect(client.submit("com.example.app", "internal", 1.0))
        .rejects.toThrow("No active release");
    });
  });
});
