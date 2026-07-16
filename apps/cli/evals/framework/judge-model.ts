import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { readHarnessEnv } from "./env";

/**
 * The judge model for both eval layers. Unlike the CLI product's `getModel`, this
 * hits OpenRouter DIRECTLY with a dev key - the judge is harness code, not a
 * customer, so it must not bill through the CLI's `/v1/llm-proxy` credit proxy.
 *
 * Default is a strong model; override per call or with JUDGE_MODEL. Confirm the id
 * resolves on OpenRouter before relying on the signal.
 */
const DEFAULT_JUDGE_MODEL = "anthropic/claude-sonnet-4.5";

let provider: ReturnType<typeof createOpenRouter> | undefined;

export function buildJudgeModel(modelId?: string): LanguageModel {
    const env = readHarnessEnv();
    if (env.OPENROUTER_API_KEY == null) {
        throw new Error("OPENROUTER_API_KEY is required for the judge (it calls OpenRouter directly, not the proxy).");
    }
    provider ??= createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
    return provider.languageModel(modelId ?? env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL);
}
