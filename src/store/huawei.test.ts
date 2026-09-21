import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HuaweiAppGalleryClient } from "./huawei.js";

describe("HuaweiAppGalleryClient upload URL validation", () => {
  let root: string;
  let file: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "huawei-store-test-"));
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
});
