export interface ImageResult {
    data: string;
    mimeType: string;
}
export interface CompressOptions {
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
}
export declare function compressScreenshot(buffer: Buffer, options?: {
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
}): Promise<ImageResult>;
//# sourceMappingURL=image.d.ts.map