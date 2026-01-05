import { Jimp } from "jimp";
const DEFAULT_OPTIONS = {
    maxWidth: 800, // Safe for API limit of 2000px
    maxHeight: 1400, // Safe for API limit of 2000px
    quality: 70,
};
/**
 * Compress PNG image buffer
 * - Resize if larger than max dimensions
 * - Convert to JPEG with specified quality
 * Returns base64 encoded JPEG
 */
export async function compressScreenshot(pngBuffer, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const image = await Jimp.read(pngBuffer);
    const width = image.width;
    const height = image.height;
    // Calculate new dimensions maintaining aspect ratio
    let newWidth = width;
    let newHeight = height;
    if (width > opts.maxWidth || height > opts.maxHeight) {
        const widthRatio = opts.maxWidth / width;
        const heightRatio = opts.maxHeight / height;
        const ratio = Math.min(widthRatio, heightRatio);
        newWidth = Math.round(width * ratio);
        newHeight = Math.round(height * ratio);
    }
    // Resize if needed
    if (newWidth !== width || newHeight !== height) {
        image.resize({ w: newWidth, h: newHeight });
    }
    // Convert to JPEG buffer
    const jpegBuffer = await image.getBuffer("image/jpeg", { quality: opts.quality });
    return {
        data: jpegBuffer.toString("base64"),
        mimeType: "image/jpeg",
    };
}
/**
 * Get original image as base64 PNG (no compression)
 */
export function toBase64Png(buffer) {
    return {
        data: buffer.toString("base64"),
        mimeType: "image/png",
    };
}
//# sourceMappingURL=image.js.map