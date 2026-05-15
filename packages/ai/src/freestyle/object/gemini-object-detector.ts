import { external } from "@autonoma/errors";
import { type ScreenResolution, Screenshot } from "@autonoma/image";
import { Output, generateText } from "ai";
import z from "zod";
import { AI_REQUEST_TIMEOUT_MS } from "../../constants";
import { buildMessages } from "../../object/build-messages";
import { ObjectGenerationFailedError } from "../../object/object-generator";
import type { LanguageModel } from "../../registry/model-registry";
import { type DetectedObject, ObjectDetector } from "./object-detector";

const geminiDetectedObjectSchema = z.object({
    box_2d: z
        .array(z.number())
        .describe("the bounding box of the object. must be an array of 4 numbers between 0 and 1000"),
    label: z.string().optional().describe("the label of the object"),
});

type GeminiDetectedObject = z.infer<typeof geminiDetectedObjectSchema>;

const geminiBoundingBoxResponseSchema = z
    .array(geminiDetectedObjectSchema)
    .describe("The detected objects in the image");

export class GeminiImageResizingError extends Error {
    constructor(cause: Error) {
        super("There was an error resizing the image", { cause });
    }
}

export class GeminiInvalidResponseError extends Error {
    constructor(message: string) {
        super(`Gemini object detector invalid response: ${message}`);
    }
}

export class GeminiModelRequestFailedError extends Error {
    constructor(cause: Error) {
        super("The Gemini model request failed", { cause });
    }
}

export const GEMINI_OBJECT_DETECTOR_SYSTEM_PROMPT = `Return the bounding boxes of the object described by the user.

Your response should be a JSON array with the following format:
[{ "label": "the label of the object", "box_2d": [ymin, xmin, ymax, xmax] }]

The values of the box_2d array should be normalized coordinates between 0 and 1000.

Do not return masks, or any code fencing, just the JSON array.
`;

export class GeminiObjectDetector extends ObjectDetector {
    constructor(
        /** The model to use for object detection. Only gemini-flash-type models have the capability to perform object detection. */
        private readonly model: LanguageModel,
    ) {
        super();
    }

    protected async detectObjectsForResolution(
        screenshot: Screenshot,
        prompt: string,
        resolution: ScreenResolution,
    ): Promise<DetectedObject[]> {
        const results = await this.makeRequest(screenshot.buffer, prompt);
        return results.map((result) => this.parseAndScaleBox(result, resolution));
    }

    private async makeRequest(buffer: Buffer, prompt: string): Promise<GeminiDetectedObject[]> {
        const result = await external(
            () =>
                generateText({
                    model: this.model,
                    system: GEMINI_OBJECT_DETECTOR_SYSTEM_PROMPT,
                    messages: buildMessages({
                        userPrompt: prompt,
                        images: [Screenshot.fromBuffer(buffer)],
                    }),
                    temperature: 0,
                    output: Output.object({
                        schema: geminiBoundingBoxResponseSchema,
                    }),
                    timeout: AI_REQUEST_TIMEOUT_MS,
                }),
            { wrapper: (error) => new ObjectGenerationFailedError(error) },
        );

        return result.output;
    }

    private parseAndScaleBox(
        { box_2d, label }: GeminiDetectedObject,
        { width, height }: ScreenResolution,
    ): DetectedObject {
        const [ymin, xmin, ymax, xmax] = box_2d;

        if (ymin == null || xmin == null || ymax == null || xmax == null)
            throw new GeminiInvalidResponseError(`Invalid bounding box: ${box_2d}`);

        if (ymin < 0 || xmin < 0 || ymax > 1000 || xmax > 1000)
            throw new GeminiInvalidResponseError(`Invalid bounding box: ${box_2d}`);

        return {
            boundingBox: {
                x: Math.round((xmin / 1000) * width),
                y: Math.round((ymin / 1000) * height),
                width: Math.round(((xmax - xmin) / 1000) * width),
                height: Math.round(((ymax - ymin) / 1000) * height),
            },
            label,
        };
    }
}
