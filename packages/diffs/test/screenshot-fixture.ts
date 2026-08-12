import { Screenshot } from "@autonoma/image";
import sharp from "sharp";

const DEFAULT_SIZE = 100;

/** Real PNG bytes, so `Screenshot.mediaType` resolves; solid white so any annotation pixel stands out. */
export async function whiteScreenshot(
    width: number = DEFAULT_SIZE,
    height: number = DEFAULT_SIZE,
): Promise<Screenshot> {
    const buffer = await sharp({
        create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
        .png()
        .toBuffer();
    return Screenshot.fromBuffer(buffer);
}
