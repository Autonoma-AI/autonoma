import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { TextGenerationFailedError, TextGenerator } from "../src/text/text-generator";

/** A tight policy so the retry tests do not sit through the default capped backoff. */
const FAST_RETRY = { maxRetries: 3, initialDelayInMs: 1, backoffFactor: 1, maxDelayInMs: 1 };

function answering(text: string) {
    return {
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: "text" as const, text }],
        warnings: [],
    };
}

function providerError(statusCode: number, isRetryable: boolean): APICallError {
    return new APICallError({
        message: `HTTP ${statusCode}`,
        url: "https://provider.test/v1",
        requestBodyValues: {},
        statusCode,
        isRetryable,
    });
}

describe("TextGenerator", () => {
    it("returns the model's text and forwards inline media alongside the prompt", async () => {
        const prompts: unknown[] = [];
        const model = new MockLanguageModelV3({
            doGenerate: async ({ prompt }) => {
                prompts.push(prompt);
                return answering("an error toast read 'Something went wrong'");
            },
        });

        const text = await new TextGenerator({ model }).generate({
            rawMessages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "list every error message shown" },
                        { type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "video/mp4" },
                    ],
                },
            ],
        });

        expect(text).toBe("an error toast read 'Something went wrong'");
        // The media has to survive message building, or every vision read silently becomes a text-only question.
        expect(JSON.stringify(prompts)).toContain("video/mp4");
        expect(JSON.stringify(prompts)).toContain("list every error message shown");
    });

    it("retries a retryable provider error until it succeeds", async () => {
        let attempts = 0;
        const model = new MockLanguageModelV3({
            doGenerate: async () => {
                attempts++;
                if (attempts < 3) throw providerError(429, true);
                return answering("recovered");
            },
        });

        const generator = new TextGenerator({ model, retry: FAST_RETRY });
        await expect(generator.generate({ userPrompt: "q" })).resolves.toBe("recovered");
        expect(attempts).toBe(3);
    });

    it("fails fast on a non-retryable provider error, wrapped", async () => {
        let attempts = 0;
        const model = new MockLanguageModelV3({
            doGenerate: async () => {
                attempts++;
                throw providerError(401, false);
            },
        });

        const generator = new TextGenerator({ model, retry: FAST_RETRY });
        await expect(generator.generate({ userPrompt: "q" })).rejects.toThrow(TextGenerationFailedError);
        // A bad key will fail the same way every time; burning the whole backoff schedule on it wastes the
        // caller's deadline, which for the classifier is a Temporal activity timeout.
        expect(attempts).toBe(1);
    });

    it("gives up after exhausting the retry budget", async () => {
        let attempts = 0;
        const model = new MockLanguageModelV3({
            doGenerate: async () => {
                attempts++;
                throw providerError(503, true);
            },
        });

        const generator = new TextGenerator({ model, retry: FAST_RETRY });
        await expect(generator.generate({ userPrompt: "q" })).rejects.toThrow(TextGenerationFailedError);
        expect(attempts).toBe(FAST_RETRY.maxRetries + 1);
    });
});
