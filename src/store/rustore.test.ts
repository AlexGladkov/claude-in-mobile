import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuStoreClient } from "./rustore.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

const packageName = "com.example.app";

describe("RuStoreClient mutation serialization", () => {
  let root: string;
  let file: string;
  let previousCredentials: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), ".rustore-store-test-"));
    file = join(root, "app.aab");
    await writeFile(file, "payload");
    previousCredentials = process.env.RUSTORE_KEY_JSON;
    process.env.RUSTORE_KEY_JSON = JSON.stringify({
      companyId: "company",
      keyId: "key",
      privateKey,
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (previousCredentials === undefined) delete process.env.RUSTORE_KEY_JSON;
    else process.env.RUSTORE_KEY_JSON = previousCredentials;
    await rm(root, { recursive: true, force: true });
  });

  it("rejects bad artifacts before credentials or API requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new RuStoreClient().upload(packageName, "/tmp/outside.aab"))
      .rejects.toMatchObject({ code: "STORE_ARTIFACT_OUTSIDE_ROOT" });
    const linkPath = join(root, "linked.aab");
    await symlink(file, linkPath);
    await expect(new RuStoreClient().upload(packageName, linkPath))
      .rejects.toMatchObject({ code: "STORE_ARTIFACT_SYMLINK" });
    await expect(new RuStoreClient().upload(packageName, join(root, "release.txt")))
      .rejects.toMatchObject({ code: "STORE_ARTIFACT_INVALID_TYPE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("queues same-package uploads and notes/submission behind an in-progress upload", async () => {
    const events: string[] = [];
    let draftCount = 0;
    let noteBody: unknown;
    let submittedVersion: string | undefined;
    let releaseFirstDraft!: () => void;
    let firstDraftStartedResolve!: () => void;
    const firstDraftStarted = new Promise<void>((resolve) => {
      firstDraftStartedResolve = resolve;
    });

    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "https://public-api.rustore.ru/public/auth") {
        events.push("auth");
        return Promise.resolve(new Response(JSON.stringify({
          code: "OK",
          body: { jwtToken: "token", ttl: 3600 },
        })));
      }
      if (url.endsWith("/version") && method === "POST") {
        draftCount += 1;
        const versionId = draftCount === 1 ? 101 : 202;
        events.push(`draft-${versionId}`);
        const response = new Response(JSON.stringify({
          code: "OK",
          body: { versionId },
        }));
        if (draftCount === 1) {
          firstDraftStartedResolve();
          return new Promise<Response>((resolve) => {
            releaseFirstDraft = () => resolve(response);
          });
        }
        return Promise.resolve(response);
      }
      if (url.includes("/version/101/aab") || url.includes("/version/202/aab")) {
        const versionId = url.includes("/version/101/") ? "101" : "202";
        events.push(`upload-${versionId}`);
        return Promise.resolve(new Response(JSON.stringify({ code: "OK" })));
      }
      if (url.includes("/publishing-settings") && method === "PATCH") {
        events.push("notes");
        noteBody = JSON.parse(String(init?.body));
        return Promise.resolve(new Response(JSON.stringify({ code: "OK" })));
      }
      if (url.includes("/submit-for-moderation") && method === "POST") {
        submittedVersion = url.match(/\/version\/(\d+)\//)?.[1];
        events.push("submit");
        return Promise.resolve(new Response(JSON.stringify({ code: "OK" })));
      }
      throw new Error(`Unexpected RuStore request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new RuStoreClient();
    const firstUpload = client.upload(packageName, file);
    await firstDraftStarted;

    const secondUpload = client.upload(packageName, file);
    const notes = client.setReleaseNotes(packageName, "en-US", "queued");
    const submit = client.submit(packageName);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    releaseFirstDraft();

    const [firstResult, secondResult] = await Promise.all([firstUpload, secondUpload]);
    await Promise.all([notes, submit]);

    expect(firstResult).toEqual({ versionId: "101" });
    expect(secondResult).toEqual({ versionId: "202" });
    expect(submittedVersion).toBe("202");
    expect(noteBody).toEqual({ whatsNew: { "en-US": "queued" } });
    expect(events).toEqual([
      "auth",
      "draft-101",
      "upload-101",
      "draft-202",
      "upload-202",
      "notes",
      "submit",
    ]);
  });
});
