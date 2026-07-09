import { external, externalSync } from "@autonoma/errors";
import sharp, { type Sharp } from "sharp";
import { type ScreenResolution, getScreenshotConfig } from "./config";
import {
    type BoundingBox,
    SharpOperationFailedError,
    addTextToSharpImage,
    cropAroundPointOnSharpImage,
    drawBoundingBoxesOnSharpImage,
    drawClickCircleOnSharpImage,
    drawDragAnnotationOnSharpImage,
    getImageMetadata,
    markPointOnSharpImage,
} from "./geometry";
import { boundingBoxToImageCoordinates } from "./screen-resolution";

/**
 * Max per-channel standard deviation (on the 0-255 scale) at or below which an
 * image counts as near-uniform. A perfectly flat frame scores 0; a frame with
 * any real UI content scores well above this (an error page with sparse text
 * measures ~11), so the threshold sits far from both.
 */
const NEAR_UNIFORM_MAX_STDEV = 2;

/**
 * Scale a point, with coordinates in the actual device screen resolution,
 * to the image resolution.
 */
function scalePoint(point: { x: number; y: number }, targetResolution: ScreenResolution): { x: number; y: number } {
    const { architecture = "web", screenResolution } = getScreenshotConfig();

    if (architecture === "web") {
        return point;
    }

    if (screenResolution == null) {
        return point;
    }

    const scaleX = targetResolution.width / screenResolution.width;
    const scaleY = targetResolution.height / screenResolution.height;
    return { x: point.x * scaleX, y: point.y * scaleY };
}

export class Screenshot {
    constructor(
        public readonly buffer: Buffer,
        public readonly base64: string,
    ) {}

    private static sharpOpSync<T>(fn: () => T): T {
        return externalSync(fn, {
            wrapper: (error) => new SharpOperationFailedError(error),
        });
    }

    private static sharpOp<T>(fn: () => Promise<T>): Promise<T> {
        return external(fn, {
            wrapper: (error) => new SharpOperationFailedError(error),
        });
    }

    public static fromBase64(base64: string): Screenshot {
        return new Screenshot(Buffer.from(base64, "base64"), base64);
    }

    public static fromBuffer(buffer: Buffer): Screenshot {
        return new Screenshot(buffer, buffer.toString("base64"));
    }

    public static async fromSharp(sharpImage: Sharp): Promise<Screenshot> {
        const buffer = await Screenshot.sharpOp(() => sharpImage.toBuffer());
        return new Screenshot(buffer, buffer.toString("base64"));
    }

    public getSharpImage(): Sharp {
        return Screenshot.sharpOpSync(() => sharp(this.buffer));
    }

    public async getResolution(): Promise<ScreenResolution> {
        const sharpImage = this.getSharpImage();
        const metadata = await Screenshot.sharpOp(() => getImageMetadata(sharpImage));
        return { width: metadata.width, height: metadata.height };
    }

    /**
     * Whether the image is near-uniform: a blank or still-loading frame with
     * almost no visible content. Measured as the max per-channel standard
     * deviation being at or below `maxStdev`. Used to keep a blank capture from
     * being surfaced as a bug's hero screenshot.
     */
    public async isNearUniform(maxStdev: number = NEAR_UNIFORM_MAX_STDEV): Promise<boolean> {
        const stats = await Screenshot.sharpOp(() => this.getSharpImage().stats());
        return stats.channels.every((channel) => channel.stdev <= maxStdev);
    }

    /**
     * Draws bounding boxes on the image.
     *
     * Handles scaling issues: if the image is not at the correct resolution, the bounding boxes
     * will be rescaled appropriately.
     */
    public async drawBoundingBoxes(
        boxes: [BoundingBox, ...BoundingBox[]],
        { labelled = false }: { labelled?: boolean } = {},
    ): Promise<Screenshot> {
        const sharpImage = this.getSharpImage();
        const resolution = await this.getResolution();
        const scaledBoxes = boxes.map((box) => boundingBoxToImageCoordinates(box, resolution)) as [
            BoundingBox,
            ...BoundingBox[],
        ];
        const result = await Screenshot.sharpOp(() => drawBoundingBoxesOnSharpImage(sharpImage, scaledBoxes, labelled));
        return Screenshot.fromSharp(result);
    }

    public async addText(text: string): Promise<Screenshot> {
        const image = this.getSharpImage();
        const sharpResult = await Screenshot.sharpOp(() => addTextToSharpImage(image, text));
        return Screenshot.fromSharp(sharpResult);
    }

    /**
     * Marks a point in the image using an X.
     */
    public async markPoint(point: { x: number; y: number }, opacity = 1): Promise<Screenshot> {
        const sharpImage = this.getSharpImage();
        const { width, height } = await Screenshot.sharpOp(() => getImageMetadata(sharpImage));
        const scaledPoint = scalePoint(point, { width, height });
        const sharpResult = await Screenshot.sharpOp(() => markPointOnSharpImage(sharpImage, scaledPoint, opacity));
        return Screenshot.fromSharp(sharpResult);
    }

    /**
     * Draws a click indicator circle at the given point.
     */
    public async drawClickCircle(point: { x: number; y: number }): Promise<Screenshot> {
        const sharpImage = this.getSharpImage();
        const { width, height } = await Screenshot.sharpOp(() => getImageMetadata(sharpImage));
        const scaledPoint = scalePoint(point, { width, height });
        const sharpResult = await Screenshot.sharpOp(() => drawClickCircleOnSharpImage(sharpImage, scaledPoint));
        return Screenshot.fromSharp(sharpResult);
    }

    /**
     * Draws a drag annotation with a green start circle, red end circle, and a connecting line with arrowhead.
     */
    public async drawDragAnnotation(
        startPoint: { x: number; y: number },
        endPoint: { x: number; y: number },
    ): Promise<Screenshot> {
        const sharpImage = this.getSharpImage();
        const { width, height } = await Screenshot.sharpOp(() => getImageMetadata(sharpImage));
        const scaledStart = scalePoint(startPoint, { width, height });
        const scaledEnd = scalePoint(endPoint, { width, height });
        const sharpResult = await Screenshot.sharpOp(() =>
            drawDragAnnotationOnSharpImage(sharpImage, scaledStart, scaledEnd),
        );
        return Screenshot.fromSharp(sharpResult);
    }

    /**
     * Crops the image around the given point.
     */
    public async cropAroundPoint(point: { x: number; y: number }, radius: number): Promise<Screenshot> {
        const sharpImage = this.getSharpImage();
        const { width, height } = await Screenshot.sharpOp(() => getImageMetadata(sharpImage));
        const scaledPoint = scalePoint(point, { width, height });
        const sharpResult = await Screenshot.sharpOp(() =>
            cropAroundPointOnSharpImage(sharpImage, scaledPoint, radius),
        );
        return Screenshot.fromSharp(sharpResult);
    }

    toJSON() {
        return {
            size: this.buffer.length,
            base64: `${this.base64.slice(0, 16)}...`,
        };
    }
}
