import { type Point, type ScreenResolution, type Screenshot, boundingBoxCenter } from "@autonoma/image";
import type { DetectedObject, ObjectDetector } from "../object/object-detector";
import { PointDetector } from "./point-detector";

export class AmbiguousObjectDetectionError extends Error {
    constructor(
        public readonly instruction: string,
        public readonly detectionResults: DetectedObject[],
    ) {
        super(
            `Ambiguous object detection results for instruction "${instruction}": ${detectionResults.map((result) => result.label).join(", ")}`,
        );
    }
}

export class NoObjectDetectionError extends Error {
    constructor(public readonly instruction: string) {
        super(`No object detection results were returned by the model for instruction "${instruction}"`);
    }
}

/**
 * Adapter that converts an Object detector into a point detector.
 *
 * It will forward the detection request to the object detector, expecting a single object to be detected.
 * If so, it will return the center of the bounding box of the detected object.
 */
export class ObjectPointDetector extends PointDetector {
    constructor(private readonly objectDetector: ObjectDetector) {
        super();
    }

    protected async detectPointForResolution(
        _screenshot: Screenshot,
        _prompt: string,
        _resolution: ScreenResolution,
    ): Promise<{ x: number; y: number }> {
        // This method is never used, but we need to override the method to satisfy the type checker.
        throw new Error("Unreachable");
    }

    override async detectPoint(
        screenshot: Screenshot,
        prompt: string,
        targetResolution?: ScreenResolution,
    ): Promise<Point> {
        const detectionResults = await this.objectDetector.detectObjects(screenshot, prompt, targetResolution);

        if (detectionResults.length === 0) throw new NoObjectDetectionError(prompt);
        if (detectionResults.length > 1) throw new AmbiguousObjectDetectionError(prompt, detectionResults);

        // biome-ignore lint/style/noNonNullAssertion: Length > 0
        return boundingBoxCenter(detectionResults[0]!.boundingBox);
    }
}
