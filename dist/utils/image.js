import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import { randomBytes } from "crypto";
const execAsync = promisify(exec);
export async function compressScreenshot(buffer, options = {}) {
    const { maxWidth = 800, maxHeight = 1400, quality = 70 } = options;
    const uniqueId = randomBytes(8).toString("hex");
    const tmpInput = `/tmp/screenshot_${uniqueId}_in.png`;
    const tmpOutput = `/tmp/screenshot_${uniqueId}_out.jpg`;
    await fs.writeFile(tmpInput, buffer);
    try {
        // Use escaped shell arguments to prevent injection
        const scaleFilter = `scale='min(${maxWidth},iw):min(${maxHeight},ih)'`;
        await execAsync(`ffmpeg -i "${tmpInput}" -vf "${scaleFilter}" -q:v ${quality} "${tmpOutput}"`);
        const compressed = await fs.readFile(tmpOutput);
        return {
            data: compressed.toString("base64"),
            mimeType: "image/jpeg",
        };
    }
    catch (error) {
        // Fallback: return original as PNG
        console.warn(`Screenshot compression failed: ${error instanceof Error ? error.message : error}`);
        return {
            data: buffer.toString("base64"),
            mimeType: "image/png",
        };
    }
    finally {
        // Always cleanup temp files
        await fs.unlink(tmpInput).catch(() => { });
        await fs.unlink(tmpOutput).catch(() => { });
    }
}
//# sourceMappingURL=image.js.map