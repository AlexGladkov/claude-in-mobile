/**
 * Plain-buffer encoding helpers that don't require an image backend.
 */

export function toBase64Png(buffer: Buffer): { data: string; mimeType: string } {
  return {
    data: buffer.toString("base64"),
    mimeType: "image/png",
  };
}
