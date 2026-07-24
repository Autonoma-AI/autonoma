import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { readEnv } from "../env";
import { resolveApiUrl } from "./api-url";

export const DEFAULT_MODEL = "google/gemini-3-flash-preview";

// Passed as the AI SDK's `maxRetries` on every model call. The SDK default of 2 gave up on
// transient provider blips after 3 attempts; 10 rides them out. The SDK handles the backoff and
// only retries retryable (429/5xx/network) errors, failing fast on 4xx.
export const AI_MAX_RETRIES = 10;

let provider: ReturnType<typeof createOpenRouter> | undefined;

/**
 * Build the model provider against Autonoma's managed LLM proxy. The CLI no
 * longer needs an OpenRouter key: it authenticates with the Autonoma API token
 * (the same key the web app injects, or AUTONOMA_API_TOKEN), and our API
 * forwards to OpenRouter on our key, metering the org's credits. The OpenRouter
 * AI-SDK provider posts to `${baseURL}/chat/completions`, which the proxy serves.
 */
function getProvider() {
    if (provider != null) return provider;

    const token = readEnv().AUTONOMA_API_TOKEN?.trim();
    if (!token) {
        throw new Error("Not authenticated - launch the planner from the Autonoma app, or set AUTONOMA_API_TOKEN.");
    }

    const apiUrl = resolveApiUrl(readEnv().AUTONOMA_API_URL);
    provider = createOpenRouter({ apiKey: token, baseURL: `${apiUrl}/v1/llm-proxy` });
    return provider;
}

export function getModel(modelId?: string) {
    return getProvider().languageModel(modelId ?? readEnv().OPENROUTER_MODEL ?? DEFAULT_MODEL);
}
