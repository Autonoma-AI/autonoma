import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { readEnv } from "../env";

export const DEFAULT_MODEL = "google/gemini-3-flash-preview";

// Production API host. Overridable with AUTONOMA_API_URL to target an
// alpha/preview host. Keep in sync with config.ts.
const DEFAULT_API_URL = "https://autonoma.app";

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

    const apiUrl = (readEnv().AUTONOMA_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
    provider = createOpenRouter({ apiKey: token, baseURL: `${apiUrl}/v1/llm-proxy` });
    return provider;
}

export function getModel(modelId?: string) {
    return getProvider().languageModel(modelId ?? readEnv().OPENROUTER_MODEL ?? DEFAULT_MODEL);
}
