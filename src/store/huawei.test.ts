import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HuaweiAppGalleryClient } from "./huawei.js";

describe("HuaweiAppGalleryClient upload URL validation", () => {
  let root: string;
  let file: string;

  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), ".huawei-store-test-"));
    file = join(root, "app.aab");
    await writeFile(file, "payload");
    process.env.HUAWEI_CLIENT_ID = "client";
    process.env.HUAWEI_CLIENT_SECRET = "secret";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.HUAWEI_CLIENT_ID;
    delete process.env.HUAWEI_CLIENT_SECRET;
    await rm(root, { recursive: true, force: true });
  });

  it("rejects bad artifacts before OAuth or upload requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new HuaweiAppGalleryClient().upload("com.example.app", "/tmp/outside.aab"))
      .rejects.toMatchObject({ code: "STORE_ARTIFACT_OUTSIDE_ROOT" });
    const linkPath = join(root, "linked.aab");
    await symlink(file, linkPath);
    await expect(new HuaweiAppGalleryClient().upload("com.example.app", linkPath))
      .rejects.toMatchObject({ code: "STORE_ARTIFACT_SYMLINK" });
    await expect(new HuaweiAppGalleryClient().upload("com.example.app", join(root, "release.txt")))
      .rejects.toMatchObject({ code: "STORE_ARTIFACT_INVALID_TYPE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects upload sessions outside trusted Huawei domains", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token", expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: { code: 0, msg: "ok" },
        appIds: [{ appId: "app-id", packageName: "com.example.app" }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ret: { code: 0, msg: "ok" },
        uploadUrl: "https://huawei.com.attacker.example/upload",
        authCode: "upload-token",
      })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new HuaweiAppGalleryClient().upload("com.example.app", file))
      .rejects.toThrow("untrusted upload URL");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("queues same-package uploads and submission notes behind an in-progress upload", async () => {
    const events: string[] = [];
    let uploadUrlCount = 0;
    let fileUploadCount = 0;
    let noteBody: unknown;
    let releaseFirstUploadUrl!: () => void;
    let firstUploadUrlStartedResolve!: () => void;
    const firstUploadUrlStarted = new Promise<void>((resolve) => {
      firstUploadUrlStartedResolve = resolve;
    });

    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "https://connect-api.cloud.huawei.com/api/oauth2/v1/token") {
        events.push("oauth");
        return Promise.resolve(new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
        ));
      }
      if (url.includes("/app-id-list?")) {
        events.push("app-id");
        return Promise.resolve(new Response(JSON.stringify({
          ret: { code: 0, msg: "ok" },
          appIds: [{ appId: "app-id", packageName: "com.example.app" }],
        })));
      }
      if (url.includes("/files/uploadUrl?")) {
        uploadUrlCount += 1;
        events.push(`upload-url-${uploadUrlCount}`);
        const response = new Response(JSON.stringify({
          ret: { code: 0, msg: "ok" },
          uploadUrl: "https://upload.huawei.com/upload",
          authCode: `upload-token-${uploadUrlCount}`,
        }));
        if (uploadUrlCount === 1) {
          firstUploadUrlStartedResolve();
          return new Promise<Response>((resolve) => {
            releaseFirstUploadUrl = () => resolve(response);
          });
        }
        return Promise.resolve(response);
      }
      if (url.startsWith("https://upload.huawei.com/")) {
        fileUploadCount += 1;
        events.push(`file-upload-${fileUploadCount}`);
        return Promise.resolve(new Response(JSON.stringify({
          result: { resultCode: 0 },
          fileInfoList: [{
            fileId: `file-${fileUploadCount}`,
            fileName: "app.aab",
          }],
        })));
      }
      if (url.includes("/app-file-info?") && method === "PUT") {
        events.push("attach");
        return Promise.resolve(new Response(JSON.stringify({ ret: { code: 0 } })));
      }
      if (url.includes("/app-language-info?") && method === "PUT") {
        events.push("notes");
        noteBody = JSON.parse(String(init?.body));
        return Promise.resolve(new Response(JSON.stringify({ ret: { code: 0 } })));
      }
      if (url.includes("/app-submit?") && method === "POST") {
        events.push("submit");
        return Promise.resolve(new Response(JSON.stringify({ ret: { code: 0 } })));
      }
      throw new Error(`Unexpected Huawei request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HuaweiAppGalleryClient();
    const firstUpload = client.upload("com.example.app", file);
    await firstUploadUrlStarted;

    const secondUpload = client.upload("com.example.app", file);
    const notes = client.setReleaseNotes("com.example.app", "en-US", "queued");
    const submit = client.submit("com.example.app");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    releaseFirstUploadUrl();

    const results = await Promise.all([firstUpload, secondUpload, notes, submit]);
    expect(results[0]).toEqual({ versionId: "file-1" });
    expect(results[1]).toEqual({ versionId: "file-2" });
    expect(noteBody).toEqual({ lang: "en-US", newFeatures: "queued" });
    expect(events).toEqual([
      "oauth",
      "app-id",
      "upload-url-1",
      "file-upload-1",
      "attach",
      "upload-url-2",
      "file-upload-2",
      "attach",
      "notes",
      "submit",
    ]);
  });
  it("rejects submit before upload and after a fresh client restart without a submit request", async () => {
    let submitRequestCount = 0;
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "https://connect-api.cloud.huawei.com/api/oauth2/v1/token") {
        return Promise.resolve(new Response(
          JSON.stringify({ access_token: "token", expires_in: 3600 }),
        ));
      }
      if (url.includes("/app-id-list?")) {
        return Promise.resolve(new Response(JSON.stringify({
          ret: { code: 0, msg: "ok" },
          appIds: [{ appId: "app-id", packageName: "com.example.app" }],
        })));
      }
      if (url.includes("/files/uploadUrl?")) {
        return Promise.resolve(new Response(JSON.stringify({
          ret: { code: 0, msg: "ok" },
          uploadUrl: "https://upload.huawei.com/upload",
          authCode: "upload-token",
        })));
      }
      if (url.startsWith("https://upload.huawei.com/")) {
        return Promise.resolve(new Response(JSON.stringify({
          result: { resultCode: 0 },
          fileInfoList: [{ fileId: "file-1", fileName: "app.aab" }],
        })));
      }
      if (url.includes("/app-file-info?") && method === "PUT") {
        return Promise.resolve(new Response(JSON.stringify({ ret: { code: 0 } })));
      }
      if (url.includes("/app-submit?") && method === "POST") {
        submitRequestCount += 1;
        return Promise.resolve(new Response(JSON.stringify({ ret: { code: 0 } })));
      }
      throw new Error(`Unexpected Huawei request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HuaweiAppGalleryClient();
    await expect(client.submit("com.example.app"))
      .rejects.toThrow("Huawei: no active upload");
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(client.upload("com.example.app", file)).resolves.toEqual({ versionId: "file-1" });
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const restartedClient = new HuaweiAppGalleryClient();
    await expect(restartedClient.submit("com.example.app"))
      .rejects.toThrow("Huawei: no active upload");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(submitRequestCount).toBe(0);
  });
});
