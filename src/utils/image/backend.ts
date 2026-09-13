/**
 * Optional Sharp (native libvips) backend loader.
 * Returns null if `sharp` is not installed; caller falls back to Jimp.
 * Result is cached after first call.
 */

export interface SharpPipeline {
  metadata(): Promise<{ width?: number; height?: number }>;
  resize(width: number, height: number, options: { fit: "inside" }): SharpPipeline;
  jpeg(options: { quality: number }): SharpPipeline;
  toBuffer(): Promise<Buffer>;
}

export type SharpFactory = (input: Buffer) => SharpPipeline;

let sharpModule: SharpFactory | null | undefined;

export async function tryLoadSharp(): Promise<SharpFactory | null> {
  if (sharpModule !== undefined) return sharpModule;
  try {
    // Use variable to prevent TypeScript from resolving the module at compile time.
    // Sharp is an optional dependency — may not be installed.
    const moduleName = "sharp";
    const imported: unknown = await import(/* webpackIgnore: true */ moduleName);
    const candidate = typeof imported === "object" && imported !== null
      ? Reflect.get(imported, "default") ?? imported
      : imported;
    if (typeof candidate !== "function") {
      sharpModule = null;
      return null;
    }
    sharpModule = candidate as SharpFactory;
    return sharpModule;
  } catch {
    sharpModule = null;
    return null;
  }
}
