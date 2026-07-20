import { DEFAULT_RETRY_CONFIG, type RetryConfig, buildRetry } from "@autonoma/agent-core";
import { external } from "@autonoma/errors";
import { Output, type ToolSet, generateText, stepCountIs } from "ai";
import type z from "zod";
import { AI_REQUEST_TIMEOUT_MS } from "../constants";
import type { LanguageModel } from "../registry/model-registry";
import { type ObjectGenerationParams, buildMessages } from "./build-messages";
import { InvalidVideoInputError, modelSupportsVideo } from "./video/video-input";

export interface ObjectGeneratorConfig<TResult> {
    model: LanguageModel;
    systemPrompt?: string;
    schema: z.ZodType<TResult>;
    tools?: ToolSet;

    /** Retry policy for the generation call. Defaults to {@link DEFAULT_RETRY_CONFIG} (10 retries, capped backoff). */
    retry?: RetryConfig;
}

export class ObjectGenerationFailedError extends Error {
    constructor(cause: Error) {
        super("There was an error generating the object", { cause });
    }
}

export class ObjectGenerator<TResult> {
    private readonly retryOperation?: <T>(operation: () => Promise<T>) => Promise<T>;

    constructor(private readonly config: ObjectGeneratorConfig<TResult>) {
        this.retryOperation = buildRetry(config.retry ?? DEFAULT_RETRY_CONFIG);
    }

    async generate(params: ObjectGenerationParams): Promise<TResult> {
        const { model, systemPrompt, schema, tools } = this.config;

        if (params.video != null && !modelSupportsVideo(model)) throw new InvalidVideoInputError();

        const operation = async () => {
            const generationResult = await generateText({
                model,
                system: systemPrompt,
                output: Output.object({ schema }),
                messages: buildMessages(params),
                maxRetries: 0,
                timeout: AI_REQUEST_TIMEOUT_MS,
                experimental_telemetry: { isEnabled: true },
                ...(tools && { tools, stopWhen: stepCountIs(5) }),
            });

            // Strip null bytes (\u0000) from AI responses — PostgreSQL JSON columns reject them
            return JSON.parse(JSON.stringify(generationResult.output).replaceAll("\\u0000", ""));
        };

        return external(() => (this.retryOperation != null ? this.retryOperation(operation) : operation()), {
            wrapper: (error) => new ObjectGenerationFailedError(error),
        });
    }
}
