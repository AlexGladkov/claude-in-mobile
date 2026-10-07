import { describe, it, expect, vi } from "vitest";
import { Jimp } from "jimp";
import { screenshotTools } from "./screenshot-tools.js";
import type { ToolContext } from "./context.js";
import { screenMeta } from "./meta/screen-meta.js";

function findHandler(name: string) {
  const def = screenshotTools.find((t) => t.tool.name === name);
  if (!def) throw new Error(`Tool "${name}" not found in screenshotTools`);
  return def.handler;
}

async function solidPngSized(w: number, h: number, color: number): Promise<Buffer> {
  return await new Jimp({ width: w, height: h, color }).getBuffer("image/png");
}

async function decodedWidth(dataB64: string): Promise<number> {
  const img = await Jimp.read(Buffer.from(dataB64, "base64"));
  return img.width;
}

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    deviceManager: {
      getCurrentPlatform: vi.fn(() => "android"),
      getScreenshotBufferAsync: vi.fn(),
      getScreenshotBuffer: vi.fn(),
    } as any,
    lastScreenshotMap: new Map(),
    screenshotScaleMap: new Map(),
    turboDefault: false,
    ...overrides,
  } as any;
}

/**
 * Regression guard for #56: screen(capture, preset) must actually change the
 * output. The bug had TWO independent sources that both had to be fixed:
 *   1. the capture zod schema declared `.default(540/960/55)` so args were
 *      never undefined and `args.X ?? preset` always took the (default) arg;
 *   2. the meta facade published `default:` in its JSON inputSchema, so LLM
 *      clients pre-filled the params before tool_use — same dead-end.
 * A merge (adopt-tree-wholesale) reverted both plus this test, so the guard
 * asserts BOTH layers, not only the internal handler.
 */
describe("screen_capture — preset applies (#56)", () => {
  const handler = findHandler("screen_capture");

  async function captureWidth(
    args: Record<string, unknown>,
    dispatch: (a: Record<string, unknown>, ctx: ToolContext) => Promise<any> = (a, ctx) =>
      handler(a, ctx),
  ): Promise<number> {
    // Source larger than the high preset so downscaling differences are visible.
    const src = await solidPngSized(1000, 2000, 0x112233ff);
    const ctx = makeCtx({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "android"),
        getScreenshotBufferAsync: vi.fn(async () => src),
        getScreenshotBuffer: vi.fn(async () => src),
      } as any,
    });
    const res: any = await dispatch({ platform: "android", ...args }, ctx);
    return decodedWidth(res.image.data);
  }

  // Layer 1: internal zod-validated handler (the .default -> .optional fix).
  describe("internal handler (zod layer)", () => {
    it("low < medium(default) < high — preset changes the output size", async () => {
      const low = await captureWidth({ preset: "low" });
      const def = await captureWidth({}); // no preset → medium default
      const high = await captureWidth({ preset: "high" });
      expect(low).toBeLessThan(def);
      expect(def).toBeLessThan(high);
      expect(low).toBeLessThanOrEqual(270);
      expect(high).toBeGreaterThan(540);
    });

    it("explicit maxWidth overrides preset", async () => {
      const w = await captureWidth({ preset: "high", maxWidth: 100 });
      expect(w).toBeLessThanOrEqual(100);
    });

    it("no preset + no explicit dims still yields concrete medium output", async () => {
      // Guards the handler-side medium fallback: with params now .optional()
      // a missing value must NOT reach compress as undefined.
      const def = await captureWidth({});
      expect(def).toBeGreaterThan(0);
      expect(def).toBeLessThanOrEqual(540);
    });
  });

  // Layer 2: the meta facade — the second, independent source of the bug.
  describe("meta facade (screen inputSchema)", () => {
    const props = (screenMeta.tool.inputSchema as any).properties as Record<
      string,
      Record<string, unknown>
    >;

    it("does NOT publish `default:` on maxWidth/maxHeight/quality", () => {
      // A JSON-schema default makes LLM clients pre-fill these before tool_use,
      // shadowing `preset` exactly like the old zod .default() did.
      for (const key of ["maxWidth", "maxHeight", "quality"]) {
        expect(props[key], `screen facade should expose ${key}`).toBeDefined();
        expect(props[key]).not.toHaveProperty("default");
      }
    });

    it("preset applies when dispatched through the meta facade", async () => {
      const low = await captureWidth({ preset: "low" }, (a, ctx) =>
        screenMeta.handler({ action: "capture", ...a }, ctx),
      );
      const high = await captureWidth({ preset: "high" }, (a, ctx) =>
        screenMeta.handler({ action: "capture", ...a }, ctx),
      );
      expect(low).toBeLessThan(high);
      expect(low).toBeLessThanOrEqual(270);
    });
  });

  // Bounds clamp: out-of-range dims must be rejected, not drive an unbounded
  // sharp.resize() (DoS vector). The param descriptions advertise Max 2000 /
  // quality 1-100, so the schema must enforce them.
  describe("dimension/quality bounds", () => {
    it("rejects maxWidth above the advertised 2000 ceiling", async () => {
      const ctx = makeCtx();
      await expect(
        handler({ platform: "android", maxWidth: 100000 }, ctx),
      ).rejects.toThrow();
    });

    it("rejects quality outside 1-100", async () => {
      const ctx = makeCtx();
      await expect(
        handler({ platform: "android", quality: 500 }, ctx),
      ).rejects.toThrow();
    });
  });
});

describe("screen_capture — coordinate transform state", () => {
  const handler = findHandler("screen_capture");

  it("records full-resolution PNG dimensions per device when compression is disabled", async () => {
    const source = await solidPngSized(1206, 2622, 0x112233ff);
    const ctx = makeCtx({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        getScreenshotBufferAsync: vi.fn(async () => source),
      } as any,
    });

    await handler({ platform: "ios", deviceId: "device-a", compress: false }, ctx);

    expect(ctx.screenshotScaleMap.get("ios:device-a")).toEqual({
      scaleX: 1,
      scaleY: 1,
      originalWidth: 1206,
      originalHeight: 2622,
    });
  });
  it("keys a capture without deviceId by the active device, so input naming that device finds it", async () => {
    const source = await solidPngSized(1206, 2622, 0x112233ff);
    const ctx = makeCtx({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        getActiveDevice: vi.fn(() => ({ id: "device-a" })),
        getScreenshotBufferAsync: vi.fn(async () => source),
      } as any,
    });

    const result = await handler({ platform: "ios", preset: "low" }, ctx);

    const frame = ctx.screenshotScaleMap.get("ios:device-a");
    expect(frame?.originalWidth).toBe(1206);
    expect(ctx.screenshotScaleMap.has("ios")).toBe(false);
    expect((result as { text: string }).text).toMatch(/^Screenshot: \d+x480 \(device: 1206x2622 px\)/);
  });

  it("records the frame of a full screenshot returned by a diff capture", async () => {
    const source = await solidPngSized(1206, 2622, 0x112233ff);
    const ctx = makeCtx({
      deviceManager: {
        getCurrentPlatform: vi.fn(() => "ios"),
        getScreenshotBufferAsync: vi.fn(async () => source),
      } as any,
    });

    await handler({ platform: "ios", deviceId: "device-a", diff: true, preset: "low" }, ctx);

    expect(ctx.screenshotScaleMap.get("ios:device-a")?.originalHeight).toBe(2622);
  });
});

