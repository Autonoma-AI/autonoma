import { AI_REQUEST_TIMEOUT_MS, ObjectGenerationFailedError, buildMessages, type LanguageModel } from "@autonoma/ai";
import { external } from "@autonoma/errors";
import { type ScreenResolution, Screenshot } from "@autonoma/image";
import { Output, generateText } from "ai";
import z from "zod";
import { type DetectedObject, ObjectDetector } from "./object-detector";

const NORMALIZED_MAX = 1000;

const qwenBoundingBoxSchema = z.object({
    bbox_2d: z
        .array(z.number())
        .length(4)
        .describe("the bounding box of the element as [x1, y1, x2, y2], normalized 0-1000"),
    label: z.string().optional().describe("the label of the element"),
});

type QwenBoundingBox = z.infer<typeof qwenBoundingBoxSchema>;

export const QWEN_OBJECT_DETECTOR_SYSTEM_PROMPT = `You are a precise GUI grounding model. The user names a single UI element visible in the screenshot.

Return that element's bounding box as JSON: { "bbox_2d": [x1, y1, x2, y2] }.

Coordinates are normalized between 0 and 1000, where x is horizontal (0 = left edge, 1000 = right edge) and y is vertical (0 = top edge, 1000 = bottom edge), relative to the image.

Return only the JSON object - no prose, no code fences.
`;

export class QwenInvalidResponseError extends Error {
    constructor(message: string) {
        super(`Qwen object detector invalid response: ${message}`);
    }
}

/**
 * {@link ObjectDetector} backed by a Qwen3-VL grounding model. Qwen returns a single
 * `bbox_2d` in 0-1000 normalized coordinates (distinct from Gemini's `box_2d` / ymin-first
 * convention), which we convert to image-pixel coordinates. Pair with {@link ObjectPointDetector}
 * to get a click point (the box center).
 */
export class QwenObjectDetector extends ObjectDetector {
    constructor(private readonly model: LanguageModel) {
        super();
    }

    protected async detectObjectsForResolution(
        screenshot: Screenshot,
        prompt: string,
        resolution: ScreenResolution,
    ): Promise<DetectedObject[]> {
        const box = await this.makeRequest(screenshot.buffer, prompt);
        return [this.parseAndScaleBox(box, resolution)];
    }

    private async makeRequest(buffer: Buffer, prompt: string): Promise<QwenBoundingBox> {
        const result = await external(
            () =>
                generateText({
                    model: this.model,
                    system: QWEN_OBJECT_DETECTOR_SYSTEM_PROMPT,
                    messages: buildMessages({
                        userPrompt: prompt,
                        images: [Screenshot.fromBuffer(buffer)],
                    }),
                    temperature: 0,
                    output: Output.object({ schema: qwenBoundingBoxSchema }),
                    timeout: AI_REQUEST_TIMEOUT_MS,
                }),
            { wrapper: (error) => new ObjectGenerationFailedError(error) },
        );

        return result.output;
    }

    private parseAndScaleBox({ bbox_2d, label }: QwenBoundingBox, { width, height }: ScreenResolution): DetectedObject {
        const [x1, y1, x2, y2] = bbox_2d;

        if (x1 == null || y1 == null || x2 == null || y2 == null)
            throw new QwenInvalidResponseError(`Invalid bounding box: ${bbox_2d}`);

        const outOfRange = [x1, y1, x2, y2].some((value) => value < 0 || value > NORMALIZED_MAX);
        if (outOfRange) throw new QwenInvalidResponseError(`Bounding box out of 0-${NORMALIZED_MAX} range: ${bbox_2d}`);

        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        return {
            boundingBox: {
                x: Math.round((left / NORMALIZED_MAX) * width),
                y: Math.round((top / NORMALIZED_MAX) * height),
                width: Math.round((Math.abs(x2 - x1) / NORMALIZED_MAX) * width),
                height: Math.round((Math.abs(y2 - y1) / NORMALIZED_MAX) * height),
            },
            label,
        };
    }
}
