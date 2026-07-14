import type { BoundingBox, ScreenResolution, Screenshot } from "@autonoma/image";
import { resolveResolution } from "../resolution-fallback";

export interface DetectedObject {
    boundingBox: BoundingBox;
    label?: string;
}

/** A model capable of detecting objects in an image according to a prompt. */
export abstract class ObjectDetector {
    /**
     * Detects objects in the image according to a prompt and a given target resolution.
     *
     * The result should be returned in image coordinates (i.e. the ones returned by the {@link Screenshot}`.getResolution()` method).
     */
    protected abstract detectObjectsForResolution(
        screenshot: Screenshot,
        prompt: string,
        resolution: ScreenResolution,
    ): Promise<DetectedObject[]>;

    /**
     * Detects objects in the image according to a prompt.
     *
     * The `resolution` optional parameter controls the coordinate space used in the results.
     *
     * If not provided, we will default to the device resolution, if configured, or the image resolution otherwise.
     * See {@link resolveResolution} for more details.
     */
    async detectObjects(
        screenshot: Screenshot,
        prompt: string,
        targetResolution?: ScreenResolution,
    ): Promise<DetectedObject[]> {
        const resolution = await resolveResolution(screenshot, targetResolution);
        return this.detectObjectsForResolution(screenshot, prompt, resolution);
    }
}
