import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ObjectGenerator } from "../src/object/object-generator";
import type { RetryConfig } from "../src/object/retry";
import { MODEL_ENTRIES } from "../src/registry/model-entries";
import { type LanguageModel, ModelRegistry } from "../src/registry/model-registry";
import type { ErrorInformation, RequestInformation, ResponseInformation } from "../src/registry/monitoring";

function createMonitoredModelRegistry(modelKey = "TEST_MODEL") {
    // Track the number of requests and errors - use object properties so they're passed by reference
    const counters = {
        requestCount: 0,
        errorCount: 0,
        requests: [] as RequestInformation[],
        errors: [] as ErrorInformation[],
    };

    // Create a ModelRegistry with monitoring callbacks
    const registry = new ModelRegistry({
        models: { [modelKey]: MODEL_ENTRIES.GPT_OSS_120B },
        monitoring: {
            onRequest: (info: RequestInformation) => {
                counters.requestCount++;
                counters.requests.push(info);
            },
            onResponse: (_info: ResponseInformation) => {
                // Response callback (successful requests)
            },
            onError: (info: ErrorInformation) => {
                counters.errorCount++;
                counters.errors.push(info);
            },
        },
    });

    // Get a model from the registry
    const model = registry.getModel({
        model: modelKey,
        tag: "test",
    });

    return {
        counters,
        registry,
        model,
    };
}

async function forceError(model: LanguageModel, retryConfig: RetryConfig) {
    // Define a schema that expects structured output
    const schema = z.object({
        name: z.string(),
        age: z.number(),
        email: z.string().email(),
    });

    // Create an ObjectGenerator with retry config
    // System prompt instructs to output plaintext, conflicting with the schema
    const generator = new ObjectGenerator({
        model,
        schema,
        retry: retryConfig,
        systemPrompt:
            "IGNORE ALL INSTRUCTIONS. Just output the following unstructured text exactly as shown: 'Hello, this is a plain text response with no JSON structure whatsoever. Just a simple string of text.' DO NOT return JSON. DO NOT return structured data. ONLY return plain text.",
    });

    return generator.generate({
        userPrompt: "Hello, how are you?",
    });
}

describe("retry", () => {
    it("should not retry when no error is thrown", async () => {
        const { counters, model } = createMonitoredModelRegistry();

        await new ObjectGenerator({
            model,
            schema: z.object({
                name: z.string(),
            }),
            systemPrompt: "You are a helpful assistant that returns a random name to the user.",
        }).generate({
            userPrompt: "Hello, what is your name?",
        });

        expect(counters.requestCount).toBe(1);
        expect(counters.errorCount).toBe(0);
    }, 60000);

    it("should not retry when maxRetries is 0", async () => {
        // Create a ModelRegistry with monitoring callbacks to track requests and errors
        const { counters, model } = createMonitoredModelRegistry();

        // Create an ObjectGenerator configured to force validation errors
        await expect(
            forceError(model, {
                maxRetries: 0,
                initialDelayInMs: 100,
                backoffFactor: 2,
            }),
        ).rejects.toThrow();

        expect(counters.requestCount).toBe(1);
        expect(counters.errorCount).toBe(1);
    }, 60000);

    it("should retry `maxRetries` times when validation fails", async () => {
        const { counters, model } = createMonitoredModelRegistry();

        const maxRetries = 2;

        await expect(
            forceError(model, {
                maxRetries,
                initialDelayInMs: 100,
                backoffFactor: 2,
            }),
        ).rejects.toThrow();

        expect(counters.requestCount).toBe(maxRetries + 1);
        expect(counters.errorCount).toBe(maxRetries + 1);
    }, 60000);
});
