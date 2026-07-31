import { generateText } from "ai";
import type { GenerationParams } from "../build-messages";
import { type GeneratorConfig, runGeneration } from "../run-generation";

export type TextGeneratorConfig = GeneratorConfig;

/**
 * Carries the underlying failure's message, not just a constant. Callers that surface a failed generation to a
 * model - "could not analyze the video: ..." - read `message`, and a fixed string tells the reader nothing: a
 * timeout it should retry narrower and a rejected media type it should stop asking about are the same sentence.
 * The cause stays attached for the stack.
 */
export class TextGenerationFailedError extends Error {
    constructor(cause: Error) {
        super(`Text generation failed: ${cause.message}`, { cause });
    }
}

/**
 * Free-text generation: the counterpart to {@link ObjectGenerator} for the calls whose answer is prose rather
 * than a schema, so no caller has to reach for the AI SDK directly to ask a model a plain question.
 *
 * A recording goes through the `video` param whatever form it took: an `UploadedVideo` comes from the
 * `VideoUploader` the model's registry entry declares, and carries either a Files-API URI or inline base64 -
 * both ride as the same `file` part, so no caller picks a transport. `rawMessages` is for assembling a message
 * shape the other params cannot express, not for media.
 */
export class TextGenerator {
    constructor(private readonly config: TextGeneratorConfig) {}

    async generate(params: GenerationParams): Promise<string> {
        return await runGeneration(
            this.config,
            params,
            (cause) => new TextGenerationFailedError(cause),
            async (settings) => {
                const { text } = await generateText(settings);
                return text;
            },
        );
    }
}
