import { createOpenAI } from "@ai-sdk/openai";
import {
    CostCollector,
    type LanguageModel,
    type ModelEntry,
    type ModelOptions,
    ModelRegistry,
    OPENROUTER_MODEL_ENTRIES,
    simpleCostFunction,
} from "@autonoma/ai";

/**
 * Capability-named registry keys (following the engine's `{fast,smart,genius}-{visual,text}` convention).
 * - `smart-visual`: the cheap/fast tool-loop + vision model (Gemini Flash via OpenRouter), like diffs.
 * - `classifier`: the higher-quality final classifier (native OpenAI gpt-5.5 - it needs the native provider
 *   because it fails structured output through OpenRouter).
 */
export type InvestigationModelName = "smart-visual" | "classifier";

export interface InvestigationModelConfig {
    openaiApiKey: string;
    /** Override the classifier model id (default gpt-5.5). */
    classifierModelId?: string;
}

/** A per-run, metered facade over the @autonoma/ai model registry (mirrors the diffs ModelSession). */
export interface ModelSession {
    getModel(options: ModelOptions<InvestigationModelName>): LanguageModel;
    readonly costCollector: CostCollector;
}

const DEFAULT_CLASSIFIER_MODEL = "gpt-5.5";

// Approximate gpt-5.5 pricing for in-run cost metering; update if the published rate changes.
const CLASSIFIER_PRICING = simpleCostFunction({ inputCostPerM: 1.25, outputCostPerM: 10 });

/**
 * Open a metered model session. Reuses @autonoma/ai's ModelRegistry (providers, middleware, monitoring,
 * cost tracking) for the shared OpenRouter Gemini-Flash model, and registers a LOCAL native-OpenAI entry
 * for the gpt-5.5 classifier (investigation-specific, so it stays out of the shared registry). The OpenAI
 * key is injected; OpenRouter/Gemini/Groq keys are read by @autonoma/ai from its own env.
 */
export function openModelSession(config: InvestigationModelConfig): ModelSession {
    const openai = createOpenAI({ apiKey: config.openaiApiKey });
    const classifierEntry: ModelEntry = {
        createModel: () => openai.chat(config.classifierModelId ?? DEFAULT_CLASSIFIER_MODEL),
        pricing: CLASSIFIER_PRICING,
    };

    const registry = new ModelRegistry<InvestigationModelName>({
        models: {
            "smart-visual": OPENROUTER_MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW,
            classifier: classifierEntry,
        },
    });
    const costCollector = new CostCollector();

    return {
        getModel: (options) => registry.getModel(options, costCollector),
        costCollector,
    };
}
