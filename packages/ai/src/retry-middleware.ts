import type { LanguageModelMiddleware } from "ai";
import { type RetryConfig, buildRetry } from "./retry";

/**
 * A {@link LanguageModelMiddleware} that retries the underlying provider call with capped
 * exponential backoff. It wraps `doGenerate` (the raw model request), so it retries transient
 * provider failures - rate limits, 5xx, dropped connections - while leaving higher-level concerns
 * like schema validation to the caller. Consumers that install this middleware should set the AI
 * SDK's own `maxRetries: 0` so the two retry layers don't compound.
 */
export function createRetryMiddleware(config: RetryConfig): LanguageModelMiddleware {
    const retry = buildRetry(config);
    return {
        specificationVersion: "v3",
        wrapGenerate: ({ doGenerate }) => retry(async () => doGenerate()),
    };
}
