const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = Buffer.from("IHDR", "ascii");
const MAX_ENCODED_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 32_768;
const MAX_IMAGE_PIXELS = 40_000_000;

/** Reject malformed or resource-exhausting PNGs before any decoder allocates pixel memory. */
export function validatePngForDecode(pngBuffer: Buffer): void {
  if (pngBuffer.length < 24 || pngBuffer.length > MAX_ENCODED_IMAGE_BYTES) {
    throw new Error(`PNG input must be between 24 and ${MAX_ENCODED_IMAGE_BYTES} bytes`);
  }
  if (!pngBuffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || !pngBuffer.subarray(12, 16).equals(PNG_IHDR)) {
    throw new Error("Invalid PNG signature or IHDR chunk");
  }

  const width = pngBuffer.readUInt32BE(16);
  const height = pngBuffer.readUInt32BE(20);
  if (width === 0 || height === 0
    || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
    || width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`PNG dimensions exceed the ${MAX_IMAGE_PIXELS}-pixel decode limit`);
  }
}
