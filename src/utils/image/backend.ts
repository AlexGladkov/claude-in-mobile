/**
 * Optional Sharp (native libvips) backend loader.
 * Returns null if `sharp` is not installed; caller falls back to Jimp.
 * Result is cached after first call.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpModule: any | null | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tryLoadSharp(): Promise<((input: Buffer) => any) | null> {
  if (sharpModule !== undefined) return sharpModule;
  try {
    // Use variable to prevent TypeScript from resolving the module at compile time.
    // Sharp is an optional dependency — may not be installed.
    const moduleName = "sharp";
    const mod = await import(/* webpackIgnore: true */ moduleName);
    sharpModule = mod.default ?? mod;
    return sharpModule;
  } catch {
    sharpModule = null;
    return null;
  }
}
