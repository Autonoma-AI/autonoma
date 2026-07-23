/**
 * Adapted from https://github.com/vercel/ai/blob/main/packages/ai/src/util/retry-with-exponential-backoff.ts
 */
import { APICallError } from "ai";
import { getDefaultLogger } from "./logger";

export interface RetryConfig {
    maxRetries: number;
    initialDelayInMs: number;
    backoffFactor: number;
    /** Cap on the delay between retries. Defaults to 10 seconds. */
    maxDelayInMs?: number;
}

/**
 * Default retry policy for model calls. Deliberately generous - transient provider hiccups
 * (rate limits, 5xx, dropped connections) are common enough that a single-digit retry count
 * surfaces as spurious hard failures. The exponential backoff is capped by `maxDelayInMs` so
 * the total wait before giving up stays bounded (~3 minutes of pure backoff at these values)
 * instead of ballooning to the tens of minutes an uncapped 2^n curve would reach by retry 10.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 10,
    initialDelayInMs: 1000,
    backoffFactor: 2,
    maxDelayInMs: 30_000,
};

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

/**
 * Only retry errors that stand a chance of succeeding on a subsequent attempt. Provider errors
 * carry an explicit `isRetryable` signal (true for 408/409/429/5xx, false for 4xx like a bad
 * request or invalid API key) - honour it so we fail fast on permanent errors instead of
 * hammering them through the full backoff schedule. Non-`APICallError` failures (network drops,
 * timeouts, unknown errors) are treated as transient and retried.
 */
function shouldRetry(error: Error | unknown): boolean {
    if (APICallError.isInstance(error)) return error.isRetryable !== false;
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

                getDefaultLogger().warn("AI request failed, retrying", {
                    attempt: i + 1,
                    maxRetries,
                    delayMs: currentDelay,
                    error: error instanceof Error ? error.message : String(error),
                });

                // Wait before retrying
                // Inline rather than @autonoma/utils: this package is kept dependency-free
                // so it bundles lean into the published planner CLI (see README).
                await new Promise((resolve) => setTimeout(resolve, currentDelay));

                // Increase delay for next retry (exponential backoff)
                delay *= backoffFactor;
            }
        }

        throw new Error("Unreachable code");
    };
}
