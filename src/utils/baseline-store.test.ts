import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Jimp } from "jimp";
import { BaselineStore } from "./baseline-store.js";
import {
  BaselineNotFoundError,
  BaselineExistsError,
  BaselineCorruptedError,
  ValidationError,
} from "../errors.js";
import { MobileError } from "../errors.js";

async function createTestPng(width: number, height: number, color = 0xff0000ff): Promise<Buffer> {
  const image = new Jimp({ width, height, color });
  return await image.getBuffer("image/png");
}

let tempDir: string;
let store: BaselineStore;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "baseline-test-"));
  store = new BaselineStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ── Save ──

describe("save", () => {
  it("saves a baseline and returns entry", async () => {
    const png = await createTestPng(100, 100);
    const entry = await store.save("login", "android", png, { width: 100, height: 100 });
    expect(entry.name).toBe("login");
    expect(entry.platform).toBe("android");
    expect(entry.fileSize).toBeGreaterThan(0);
    expect(entry.checksum).toBeTruthy();
    expect(entry.createdAt).toBeTruthy();
  });

  it("rejects duplicate without overwrite", async () => {
    const png = await createTestPng(100, 100);
    await store.save("login", "android", png);
    await expect(store.save("login", "android", png)).rejects.toThrow(BaselineExistsError);
  });

  it("allows overwrite with flag", async () => {
    const png = await createTestPng(100, 100);
    await store.save("login", "android", png);
    const entry = await store.save("login", "android", png, { overwrite: true });
    expect(entry.name).toBe("login");
  });

  it("rejects non-PNG buffer", async () => {
    const notPng = Buffer.from("not a png file");
    await expect(store.save("test", "android", notPng)).rejects.toThrow(ValidationError);
  });

  it("rejects oversized buffer", async () => {
    const png = await createTestPng(100, 100);
    // Create artificially large buffer with PNG magic
    const large = Buffer.alloc(6 * 1024 * 1024);
    png.copy(large, 0, 0, Math.min(png.length, large.length));
    await expect(store.save("test", "android", large)).rejects.toThrow(ValidationError);
  });

  it("rejects invalid baseline name", async () => {
    const png = await createTestPng(100, 100);
    await expect(store.save("../evil", "android", png)).rejects.toThrow(MobileError);
    await expect(store.save("", "android", png)).rejects.toThrow(MobileError);
    await expect(store.save("a/b", "android", png)).rejects.toThrow(MobileError);
  });

  it("saves with tags", async () => {
    const png = await createTestPng(100, 100);
    const entry = await store.save("login", "android", png, { tags: ["auth", "onboarding"] });
    expect(entry.tags).toEqual(["auth", "onboarding"]);
  });
});

// ── Get ──

describe("get", () => {
  it("retrieves saved baseline buffer", async () => {
    const png = await createTestPng(100, 100);
    await store.save("login", "android", png);
    const buffer = await store.get("login", "android");
    expect(buffer.length).toBe(png.length);
  });

  it("throws BaselineNotFoundError for missing baseline", async () => {
    await expect(store.get("nonexistent", "android")).rejects.toThrow(BaselineNotFoundError);
  });
});

// ── Update ──

describe("update", () => {
  it("updates existing baseline", async () => {
    const png1 = await createTestPng(100, 100, 0xff0000ff);
    const png2 = await createTestPng(100, 100, 0x00ff00ff);
    await store.save("login", "android", png1);
    const entry = await store.update("login", "android", png2);
    expect(entry.name).toBe("login");

    const buffer = await store.get("login", "android");
    expect(buffer.length).toBe(png2.length);
  });

  it("throws for non-existent baseline", async () => {
    const png = await createTestPng(100, 100);
    await expect(store.update("nonexistent", "android", png)).rejects.toThrow(BaselineNotFoundError);
  });
});

// ── Delete ──

describe("delete", () => {
  it("deletes existing baseline", async () => {
    const png = await createTestPng(100, 100);
    await store.save("login", "android", png);
    await store.delete("login", "android");
    await expect(store.get("login", "android")).rejects.toThrow(BaselineNotFoundError);
  });

  it("throws for non-existent baseline", async () => {
    await expect(store.delete("nonexistent", "android")).rejects.toThrow(BaselineNotFoundError);
  });
});

// ── List ──

describe("list", () => {
  it("returns all baselines", async () => {
    const png = await createTestPng(100, 100);
    await store.save("login", "android", png);
    await store.save("home", "android", png);
    const entries = await store.list();
    expect(entries.length).toBe(2);
  });

  it("filters by platform", async () => {
    const png = await createTestPng(100, 100);
    await store.save("login", "android", png);
    await store.save("login", "ios", png);
    const androidOnly = await store.list("android");
    expect(androidOnly.length).toBe(1);
    expect(androidOnly[0].platform).toBe("android");
  });

  it("filters by tag", async () => {
    const png = await createTestPng(100, 100);
    await store.save("login", "android", png, { tags: ["auth"] });
    await store.save("home", "android", png, { tags: ["main"] });
    const authOnly = await store.list(undefined, "auth");
    expect(authOnly.length).toBe(1);
    expect(authOnly[0].name).toBe("login");
  });

  it("returns empty for no matches", async () => {
    const entries = await store.list("desktop");
    expect(entries).toEqual([]);
  });
});

// ── Env override ──

describe("env override", () => {
  it("uses CLAUDE_MOBILE_BASELINES_DIR when set", async () => {
    const customDir = join(tempDir, "custom-baselines");
    process.env.CLAUDE_MOBILE_BASELINES_DIR = customDir;
    try {
      const customStore = new BaselineStore();
      expect(customStore.getBaselinesDir()).toBe(customDir);
    } finally {
      delete process.env.CLAUDE_MOBILE_BASELINES_DIR;
    }
  });
});
