import type { Point, ScreenResolution, Screenshot } from "@autonoma/image";
import { resolveResolution } from "../resolution-fallback";

/** A model capable of selecting a point in an image according to a prompt. */
export abstract class PointDetector {
    /**
     * Detects a point in the image according to a prompt.
     *
     * The result should be returned in image coordinates (i.e. the ones returned by the {@link Screenshot}`.getResolution()` method).
     */
    protected abstract detectPointForResolution(
        screenshot: Screenshot,
        prompt: string,
        resolution: ScreenResolution,
    ): Promise<Point>;

    /**
     * Detects a point in the image according to a prompt.
     *
     * The `resolution` optional parameter controls the coordinate space used in the results.
     *
     * If not provided, we will default to the device resolution, if configured, or the image resolution otherwise.
     * See {@link resolveResolution} for more details.
     */
    async detectPoint(screenshot: Screenshot, prompt: string, targetResolution?: ScreenResolution): Promise<Point> {
        const resolution = await resolveResolution(screenshot, targetResolution);
        return this.detectPointForResolution(screenshot, prompt, resolution);
    }
}
