import { APICallError, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createRetryMiddleware } from "../src/retry-middleware";

const FAKE_USAGE = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

function apiError(isRetryable: boolean, message = "provider error"): APICallError {
    return new APICallError({ message, url: "https://example.com", requestBodyValues: {}, isRetryable });
}

/** Wrap a mock model with retry middleware that waits 0ms between attempts. */
function wrap(mock: MockLanguageModelV3) {
    return wrapLanguageModel({
        model: mock,
        middleware: createRetryMiddleware({ maxRetries: 5, initialDelayInMs: 0, backoffFactor: 2 }),
    });
}

describe("createRetryMiddleware", () => {
    it("retries the underlying model call and returns the eventual result", async () => {
        let calls = 0;
        const mock = new MockLanguageModelV3({
            doGenerate: async () => {
                calls += 1;
                if (calls < 3) throw apiError(true);
                return {
                    content: [{ type: "text", text: "ok" }],
                    finishReason: { unified: "stop", raw: "stop" },
                    usage: FAKE_USAGE,
                    warnings: [],
                };
            },
        });

        const result = await wrap(mock).doGenerate({ prompt: [] });

        expect(result.content).toEqual([{ type: "text", text: "ok" }]);
        expect(calls).toBe(3);
    });

    it("does not retry a non-retryable provider error", async () => {
        let calls = 0;
        const mock = new MockLanguageModelV3({
            doGenerate: async () => {
                calls += 1;
                throw apiError(false, "unauthorized");
            },
        });

        await expect(wrap(mock).doGenerate({ prompt: [] })).rejects.toThrow("unauthorized");
        expect(calls).toBe(1);
    });
});
