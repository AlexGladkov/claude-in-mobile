import { describe, it, expect } from "vitest";
import { Jimp } from "jimp";
import { detectUniformFrame } from "./analyze.js";

async function solidPng(w: number, h: number, color: number): Promise<Buffer> {
  return await new Jimp({ width: w, height: h, color }).getBuffer("image/png");
}

/** Left half `left`, right half `right` — a clearly non-uniform frame. */
async function splitPng(w: number, h: number, left: number, right: number): Promise<Buffer> {
  const img = new Jimp({ width: w, height: h, color: left });
  for (let y = 0; y < h; y++) {
    for (let x = Math.floor(w / 2); x < w; x++) {
      img.setPixelColor(right, x, y);
    }
  }
  return await img.getBuffer("image/png");
}

describe("detectUniformFrame", () => {
  it("flags an all-black frame as uniform and near-black", async () => {
    const png = await solidPng(200, 400, 0x000000ff);
    const r = await detectUniformFrame(png);
    expect(r.uniform).toBe(true);
    expect(r.nearBlack).toBe(true);
    expect(r.coverage).toBeGreaterThanOrEqual(0.985);
  });

  it("flags a solid non-black frame as uniform but not near-black", async () => {
    const png = await solidPng(200, 400, 0xff0000ff); // red
    const r = await detectUniformFrame(png);
    expect(r.uniform).toBe(true);
    expect(r.nearBlack).toBe(false);
  });

  it("does not flag a two-tone frame as uniform", async () => {
    const png = await splitPng(200, 400, 0x000000ff, 0xffffffff);
    const r = await detectUniformFrame(png);
    expect(r.uniform).toBe(false);
    expect(r.coverage).toBeLessThan(0.985);
  });
});
