/**
 * Adapted from https://github.com/vercel/ai/blob/main/packages/ai/src/util/retry-with-exponential-backoff.ts
 */

import { logger } from "@autonoma/logger";
import { APICallError } from "ai";

export interface RetryConfig {
    maxRetries: number;
    initialDelayInMs: number;
    backoffFactor: number;
    /** Cap on the delay between retries. Defaults to 10 seconds. */
    maxDelayInMs?: number;
}

/**
 * Calculate retry delay based on retry headers and exponential backoff
 */
function getRetryDelayInMs(error: APICallError, exponentialBackoffDelay: number): number {
    const headers = error.responseHeaders;

    if (!headers) return exponentialBackoffDelay;

    let ms: number | undefined;

    // retry-ms is more precise than retry-after and used by e.g. OpenAI
    const retryAfterMs = headers["retry-after-ms"];
    if (retryAfterMs) {
        const timeoutMs = Number.parseFloat(retryAfterMs);
        if (!Number.isNaN(timeoutMs)) {
            ms = timeoutMs;
        }
    }

    // About the Retry-After header: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After
    const retryAfter = headers["retry-after"];
    if (retryAfter && ms === undefined) {
        const timeoutSeconds = Number.parseFloat(retryAfter);
        if (!Number.isNaN(timeoutSeconds)) ms = timeoutSeconds * 1000;
        else ms = Date.parse(retryAfter) - Date.now();
    }

    // check that the delay is reasonable:
    if (ms != null && !Number.isNaN(ms) && 0 <= ms && (ms < 60 * 1000 || ms < exponentialBackoffDelay)) {
        return ms;
    }

    return exponentialBackoffDelay;
}

function shouldRetry(_error: Error | unknown): boolean {
    return true;
}

export function buildRetry({
    maxRetries = 5,
    initialDelayInMs = 100,
    backoffFactor = 2,
    maxDelayInMs = 10_000,
}: RetryConfig): <T>(operation: () => Promise<T>) => Promise<T> {
    return async (operation) => {
        let delay = initialDelayInMs;

        for (let i = 0; i < maxRetries + 1; i++) {
            try {
                return await operation();
            } catch (error) {
                if (!shouldRetry(error)) throw error;

                // If we've retried the max number of times, throw the error
                if (i === maxRetries) throw error;

                let currentDelay = Math.min(delay, maxDelayInMs);

                // Check if the error is due to a rate limit and respect retry headers
                if (APICallError.isInstance(error)) {
                    currentDelay = getRetryDelayInMs(error, currentDelay);
                }

                logger.warn("AI request failed, retrying", {
                    attempt: i + 1,
                    maxRetries,
                    delayMs: currentDelay,
                    error: error instanceof Error ? error.message : String(error),
                });

                // Wait before retrying
                await new Promise((resolve) => setTimeout(resolve, currentDelay));

                // Increase delay for next retry (exponential backoff)
                delay *= backoffFactor;
            }
        }

        throw new Error("Unreachable code");
    };
}
