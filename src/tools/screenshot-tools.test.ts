import { describe, it, expect, vi } from "vitest";
import { Jimp } from "jimp";
import { screenshotTools } from "./screenshot-tools.js";
import type { ToolContext } from "./context.js";

function findHandler(name: string) {
  const def = screenshotTools.find((t) => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in screenshotTools`);
  return def.handler;
}

async function solidPng(color: number): Promise<Buffer> {
  return await new Jimp({ width: 80, height: 160, color }).getBuffer("image/png");
}

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "android"),
      getScreenshotBufferAsync: vi.fn(),
      getAdapter: vi.fn(),
    } as any,
    lastScreenshotMap: new Map(),
    screenshotScaleMap: new Map(),
    turboDefault: false,
    ...overrides,
  } as any;
}

describe("screen_burst", () => {
  const handler = findHandler("screen_burst");

  it("captures N frames and returns interleaved text+image content", async () => {
    const png = await solidPng(0x3366ccff);
    const getBuf = vi.fn(async () => png);
    const ctx = makeCtx({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getScreenshotBufferAsync: getBuf,
        getAdapter: vi.fn(),
      } as any,
    });

    const res: any = await handler({ frames: 3, intervalMs: 30 }, ctx);

    expect(getBuf).toHaveBeenCalledTimes(3);
    const images = res.content.filter((b: any) => b.type === "image");
    expect(images).toHaveLength(3);
    for (const img of images) {
      expect(img.mimeType).toBe("image/jpeg");
      expect(img.data.length).toBeGreaterThan(0);
    }
    // leading summary + per-frame label
    const texts = res.content.filter((b: any) => b.type === "text");
    expect(texts[0].text).toMatch(/Burst: 3 frames/);
    expect(res.content.some((b: any) => b.type === "text" && /frame 1\/3/.test(b.text))).toBe(true);
  });
});

describe("screen_capture — secure/blank detection", () => {
  const handler = findHandler("screen_capture");

  it("returns a tree-fallback advisory (no image) when a black frame is a FLAG_SECURE window", async () => {
    const black = await solidPng(0x000000ff);
    const ctx = makeCtx({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getScreenshotBufferAsync: vi.fn(async () => black),
        getAdapter: vi.fn(() => ({
          platform: "android",
          isCurrentWindowSecure: () => true,
        })),
      } as any,
    });

    const res: any = await handler({ platform: "android" }, ctx);

    expect(res.content.some((b: any) => b.type === "image")).toBe(false);
    expect(res.text).toMatch(/FLAG_SECURE/);
    expect(res.text).toMatch(/ui\(action:'tree'\)/);
  });

  it("still returns the image (with a note) when a black frame is NOT a secure window", async () => {
    const black = await solidPng(0x000000ff);
    const ctx = makeCtx({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getScreenshotBufferAsync: vi.fn(async () => black),
        getAdapter: vi.fn(() => ({
          platform: "android",
          isCurrentWindowSecure: () => false,
        })),
      } as any,
    });

    const res: any = await handler({ platform: "android" }, ctx);

    expect(res.image).toBeTruthy();
    expect(res.text).toMatch(/uniform black/);
  });

  it("bypassSecureCheck returns the raw frame without probing", async () => {
    const black = await solidPng(0x000000ff);
    const getAdapter = vi.fn();
    const ctx = makeCtx({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getScreenshotBufferAsync: vi.fn(async () => black),
        getAdapter,
      } as any,
    });

    const res: any = await handler({ platform: "android", bypassSecureCheck: true }, ctx);

    expect(res.image).toBeTruthy();
    expect(getAdapter).not.toHaveBeenCalled();
  });
});
