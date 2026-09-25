import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "fs/promises";
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
    const noBody = r.status === 204 || r.status === 205 || r.status === 304;
    return Promise.resolve(new Response(noBody ? null : text, {
      status: r.status,
      headers: r.headers,
    }));
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
  let root: string;
  let tmpFile: string;
  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), ".google-play-store-test-"));
    client = new GooglePlayClient();
    tmpFile = join(root, "test.aab");
    await writeFile(tmpFile, Buffer.alloc(1024, 0x42)); // 1 KB fake AAB
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (root) await rm(root, { recursive: true, force: true });
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
    it("rejects an outside-root artifact before auth or network", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.upload("com.example.app", "/tmp/outside.aab"))
        .rejects.toMatchObject({ code: "STORE_ARTIFACT_OUTSIDE_ROOT" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a symlink artifact before auth or network", async () => {
      const linkPath = join(root, "linked.aab");
      await symlink(tmpFile, linkPath);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.upload("com.example.app", linkPath))
        .rejects.toMatchObject({ code: "STORE_ARTIFACT_SYMLINK" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it("rejects wrong extensions before auth or network", async () => {
      const wrongPath = join(root, "release.txt");
      await writeFile(wrongPath, "payload");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(client.upload("com.example.app", wrongPath))
        .rejects.toMatchObject({ code: "STORE_ARTIFACT_INVALID_TYPE" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it("does not read Google credentials for an invalid artifact", async () => {
      const previousKeyFile = process.env.GOOGLE_PLAY_KEY_FILE;
      process.env.GOOGLE_PLAY_KEY_FILE = join(root, "missing-key.json");
      try {
        const guardedClient = new GooglePlayClient();
        await expect(guardedClient.upload("com.example.app", "/tmp/outside.aab"))
          .rejects.toMatchObject({ code: "STORE_ARTIFACT_OUTSIDE_ROOT" });
      } finally {
        if (previousKeyFile === undefined) delete process.env.GOOGLE_PLAY_KEY_FILE;
        else process.env.GOOGLE_PLAY_KEY_FILE = previousKeyFile;
      }
    });

    it("throws if upload initiation fails", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: EDIT },
        { status: 403, body: "Forbidden" },
      ));
      await expect(client.upload("com.example.app", tmpFile))
        .rejects.toThrow(/403/);
    });

    it("throws if initiation response has no Location header", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: EDIT },
        { status: 200, body: {} },  // no Location
      ));
      await expect(client.upload("com.example.app", tmpFile))
        .rejects.toThrow("missing Location header");
    });

    it("rejects upload sessions outside Google API domains", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: EDIT },
        { status: 200, body: {}, headers: { location: "https://googleapis.com.attacker.example/upload" } },
      ));

      await expect(client.upload("com.example.app", tmpFile))
        .rejects.toThrow("untrusted URL");
    });

    it("throws if stream PUT fails", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 200, body: EDIT },
        { status: 200, body: {}, ...UPLOAD },
        { status: 500, body: "Internal Server Error" },
      ));
      await expect(client.upload("com.example.app", tmpFile))
        .rejects.toThrow(/500/);
    });

    it("uses /apks endpoint for .apk files", async () => {
      const apkFile = join(root, "test.apk");
      await writeFile(apkFile, Buffer.alloc(256, 0x41));

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
  it("queues same-package uploads and notes/submission behind an in-progress upload", async () => {
    const events: string[] = [];
    let createEditCount = 0;
    let nextVersionCode = 42;
    let trackBody: unknown;
    let releaseFirstEdit!: () => void;
    let firstEditStartedResolve!: () => void;
    const firstEditStarted = new Promise<void>((resolve) => {
      firstEditStartedResolve = resolve;
    });

    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/edits") && method === "POST") {
        createEditCount += 1;
        events.push(`create-edit-${createEditCount}`);
        const response = new Response(JSON.stringify(EDIT));
        if (createEditCount === 1) {
          firstEditStartedResolve();
          return new Promise<Response>((resolve) => {
            releaseFirstEdit = () => resolve(response);
          });
        }
        return Promise.resolve(response);
      }
      if (url.includes("uploadType=resumable")) {
        events.push("initiate-upload");
        return Promise.resolve(new Response(null, {
          status: 200,
          headers: { location: `https://upload.googleapis.com/resumable/${nextVersionCode}` },
        }));
      }
      if (url.startsWith("https://upload.googleapis.com/")) {
        events.push(`stream-${nextVersionCode}`);
        return Promise.resolve(new Response(
          JSON.stringify({ versionCode: nextVersionCode++ }),
        ));
      }
      if (url.includes("/tracks/internal") && method === "PUT") {
        events.push("track");
        trackBody = JSON.parse(String(init?.body));
        return Promise.resolve(new Response(JSON.stringify(OK)));
      }
      if (url.includes(":commit") && method === "POST") {
        events.push("commit");
        return Promise.resolve(new Response(JSON.stringify(OK)));
      }
      throw new Error(`Unexpected Google Play request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstUpload = client.upload("com.example.app", tmpFile);
    await firstEditStarted;

    const secondUpload = client.upload("com.example.app", tmpFile);
    const notes = client.setReleaseNotes("com.example.app", "en-US", "queued");
    const submit = client.submit("com.example.app", "internal", 1.0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    releaseFirstEdit();

    const [firstResult, secondResult] = await Promise.all([firstUpload, secondUpload]);
    await Promise.all([notes, submit]);

    expect(firstResult).toEqual({ versionCode: 42 });
    expect(secondResult).toEqual({ versionCode: 43 });
    expect(createEditCount).toBe(1);
    expect(events).toEqual([
      "create-edit-1",
      "initiate-upload",
      "stream-42",
      "initiate-upload",
      "stream-43",
      "track",
      "commit",
    ]);
    expect(trackBody).toMatchObject({
      releases: [{
        versionCodes: ["43"],
        releaseNotes: [{ language: "en-US", text: "queued" }],
      }],
    });
  });
  it("keeps different package mutations concurrent", async () => {
    let releaseFirstEdit!: () => void;
    let firstEditStartedResolve!: () => void;
    let secondEditStartedResolve!: () => void;
    const firstEditStarted = new Promise<void>((resolve) => {
      firstEditStartedResolve = resolve;
    });
    const secondEditStarted = new Promise<void>((resolve) => {
      secondEditStartedResolve = resolve;
    });

    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/edits") && method === "POST") {
        if (url.includes("/applications/com.first.app/")) {
          const response = new Response(JSON.stringify({ id: "edit-first" }));
          firstEditStartedResolve();
          return new Promise<Response>((resolve) => {
            releaseFirstEdit = () => resolve(response);
          });
        }
        if (url.includes("/applications/com.second.app/")) {
          secondEditStartedResolve();
          return Promise.resolve(new Response(JSON.stringify({ id: "edit-second" })));
        }
      }
      if (url.includes("uploadType=resumable")) {
        const packagePath = url.includes("com.first.app") ? "first" : "second";
        return Promise.resolve(new Response(null, {
          status: 200,
          headers: { location: `https://upload.googleapis.com/resumable/${packagePath}` },
        }));
      }
      if (url.startsWith("https://upload.googleapis.com/")) {
        const versionCode = url.endsWith("/first") ? 11 : 22;
        return Promise.resolve(new Response(JSON.stringify({ versionCode })));
      }
      throw new Error(`Unexpected Google Play request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstUpload = client.upload("com.first.app", tmpFile);
    await firstEditStarted;
    const secondUpload = client.upload("com.second.app", tmpFile);
    await secondEditStarted;

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("com.second.app"))).toBe(true);
    releaseFirstEdit();

    await expect(firstUpload).resolves.toEqual({ versionCode: 11 });
    await expect(secondUpload).resolves.toEqual({ versionCode: 22 });
  });
});
