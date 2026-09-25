import { lstat, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MobileError } from "../errors.js";
import { createStoreArtifactMultipartBody, stageStoreArtifact, validateStoreArtifact } from "./upload-path.js";

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("validateStoreArtifact", () => {
  it("accepts an in-root regular artifact and returns its canonical path", async () => {
    const root = await temporaryRoot(".store-upload-valid-");
    const artifactPath = join(root, "release.AAB");
    await writeFile(artifactPath, "payload");

    const validated = await validateStoreArtifact(artifactPath, "android");
    try {
      expect(validated.path).toBe(artifactPath);
      expect(validated.size).toBe(7);
      expect((await lstat(validated.path)).isSymbolicLink()).toBe(false);
    } finally {
      await validated.close();
    }
  });
  it("keeps reading the validated descriptor after the path is replaced", async () => {
    const root = await temporaryRoot(".store-upload-bound-");
    const artifactPath = join(root, "release.apk");
    const replacementPath = join(root, "replacement.apk");
    await writeFile(artifactPath, "validated-content");

    const validated = await validateStoreArtifact(artifactPath, "android");
    try {
      await writeFile(replacementPath, "replacement-content");
      await rename(replacementPath, artifactPath);

      const chunks: Buffer[] = [];
      for await (const chunk of validated.stream) {
        chunks.push(Buffer.from(chunk));
      }

      expect(Buffer.concat(chunks).toString("utf8")).toBe("validated-content");
      expect(validated.size).toBe(Buffer.byteLength("validated-content"));
    } finally {
      await validated.close();
    }
  });

  it("stages descriptor bytes in a private snapshot and removes it", async () => {
    const root = await temporaryRoot(".store-upload-snapshot-");
    const artifactPath = join(root, "release.ipa");
    const replacementPath = join(root, "replacement.ipa");
    await writeFile(artifactPath, "validated-content");

    const validated = await validateStoreArtifact(artifactPath, "ios");
    await writeFile(replacementPath, "mutated-content");
    await rename(replacementPath, artifactPath);
    const staged = await stageStoreArtifact(validated);

    try {
      expect(staged.path).not.toBe(artifactPath);
      expect(staged.size).toBe(Buffer.byteLength("validated-content"));
      expect(await readFile(staged.path, "utf8")).toBe("validated-content");
      if (process.platform !== "win32") {
        expect((await lstat(staged.path)).mode & 0o777).toBe(0o600);
        expect((await lstat(dirname(staged.path))).mode & 0o777).toBe(0o700);
      }
    } finally {
      await staged.remove();
      await validated.close();
    }

    await expect(readFile(staged.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(dirname(staged.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports the exact byte length of a streamed multipart artifact", async () => {
    const root = await temporaryRoot(".store-upload-multipart-");
    const artifactPath = join(root, "release.apk");
    await writeFile(artifactPath, "artifact bytes");

    const artifact = await validateStoreArtifact(artifactPath, "android");
    try {
      const multipart = createStoreArtifactMultipartBody(
        artifact,
        "release.apk",
        [{ name: "token", value: "секрет" }],
      );
      const body = Buffer.from(await new Response(multipart.body).arrayBuffer());

      expect(multipart.contentType).toMatch(/^multipart\/form-data; boundary=----mcp-devices-/u);
      expect(body.byteLength).toBe(multipart.contentLength);
      expect(body.toString("utf8")).toContain("artifact bytes");
      expect(body.toString("utf8")).toContain("секрет");
    } finally {
      await artifact.close();
    }
  });

  it("rejects an existing artifact outside the trusted process root", async () => {
    const outsideRoot = await mkdtemp(join(tmpdir(), "store-upload-outside-"));
    roots.push(outsideRoot);
    const artifactPath = join(outsideRoot, "release.apk");
    await writeFile(artifactPath, "payload");

    await expect(validateStoreArtifact(artifactPath, "android")).rejects.toMatchObject({
      code: "STORE_ARTIFACT_OUTSIDE_ROOT",
    });
  });

  it("rejects an artifact whose canonical parent escapes the trusted root", async () => {
    const root = await temporaryRoot(".store-upload-parent-");
    const outsideRoot = await mkdtemp(join(tmpdir(), "store-upload-parent-target-"));
    roots.push(outsideRoot);
    const targetPath = join(outsideRoot, "release.ipa");
    const parentPath = join(root, "build");
    await writeFile(targetPath, "payload");
    await symlink(outsideRoot, parentPath);

    await expect(validateStoreArtifact(join(parentPath, "release.ipa"), "ios"))
      .rejects.toMatchObject({ code: "STORE_ARTIFACT_OUTSIDE_ROOT" });
  });

  it("rejects symlink artifacts before resolving or reading the target", async () => {
    const root = await temporaryRoot(".store-upload-symlink-");
    const outsideRoot = await mkdtemp(join(tmpdir(), "store-upload-target-"));
    roots.push(outsideRoot);
    const targetPath = join(outsideRoot, "release.ipa");
    const linkPath = join(root, "release.ipa");
    await writeFile(targetPath, "payload");
    await symlink(targetPath, linkPath);

    await expect(validateStoreArtifact(linkPath, "ios")).rejects.toMatchObject({
      code: "STORE_ARTIFACT_SYMLINK",
    });
    expect(await readlink(linkPath)).toBe(targetPath);
  });

  it("rejects wrong extensions and traversal/control/empty paths", async () => {
    const root = await temporaryRoot(".store-upload-invalid-");
    const wrongExtension = join(root, "release.txt");
    await writeFile(wrongExtension, "payload");

    await expect(validateStoreArtifact(wrongExtension, "android")).rejects.toMatchObject({
      code: "STORE_ARTIFACT_INVALID_TYPE",
    });
    await expect(validateStoreArtifact(`${root}/../release.apk`, "android"))
      .rejects.toMatchObject({ code: "PATH_TRAVERSAL_BLOCKED" });
    await expect(validateStoreArtifact(`${root}/bad\u0000.apk`, "android"))
      .rejects.toMatchObject({ code: "STORE_ARTIFACT_INVALID_PATH" });
    await expect(validateStoreArtifact("", "android"))
      .rejects.toMatchObject({ code: "STORE_ARTIFACT_INVALID_PATH" });
  });

  it("does not expose file contents in validation errors", async () => {
    const root = await temporaryRoot(".store-upload-message-");
    const artifactPath = join(root, "release.txt");
    await writeFile(artifactPath, "super-secret-artifact-content");

    const error = await validateStoreArtifact(artifactPath, "android").catch((value) => value);

    expect(error).toBeInstanceOf(MobileError);
    expect((error as Error).message).not.toContain("super-secret-artifact-content");
  });
});
