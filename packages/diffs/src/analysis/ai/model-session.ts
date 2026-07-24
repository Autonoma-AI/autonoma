import { createOpenAI } from "@ai-sdk/openai";
import {
    type CostFunction,
    CostCollector,
    inputCacheCostFunction,
    type LanguageModel,
    type ModelEntry,
    type ModelOptions,
    ModelRegistry,
    OPENROUTER_MODEL_ENTRIES,
} from "@autonoma/ai";

/**
 * Capability-named registry keys (following the engine's `{fast,smart,genius}-{visual,text}` convention).
 * - `smart-visual`: the cheap/fast tool-loop + vision model (Gemini Flash via OpenRouter), like diffs.
 * - `classifier`: the higher-quality final classifier (native OpenAI gpt-5.6-luna - it needs the native
 *   provider because it fails structured output through OpenRouter).
 * - `reporter`: the Reporter agent's model - strictly above `smart-visual` because it must BOTH read
 *   screenshots (vision) AND reason across findings/issues/time (a stronger native OpenAI gpt-5.6 tier).
 */
export type InvestigationModelName = "smart-visual" | "classifier" | "reporter";

export interface InvestigationModelConfig {
    openaiApiKey: string;
    /** Override the classifier model id (default gpt-5.6-luna). */
    classifierModelId?: string;
    /** Override the Reporter model id (default gpt-5.6-terra - the stronger vision+reasoning tier). */
    reporterModelId?: string;
}

/** A per-run, metered facade over the @autonoma/ai model registry (mirrors the diffs ModelSession). */
export interface ModelSession {
    getModel(options: ModelOptions<InvestigationModelName>): LanguageModel;
    readonly costCollector: CostCollector;
}

type OpenAIProvider = ReturnType<typeof createOpenAI>;

/**
 * One native-OpenAI classifier model, bundling the two things that vary per model: how to instantiate it
 * (Responses API vs Chat Completions) and its published pricing - the same way @autonoma/ai's {@link ModelEntry}
 * keeps createModel and pricing together so they can never drift apart.
 */
interface ClassifierModel {
    createModel: (openai: OpenAIProvider) => LanguageModel;
    pricing: CostFunction;
}

const DEFAULT_CLASSIFIER_MODEL = "gpt-5.6-luna";
const DEFAULT_REPORTER_MODEL = "gpt-5.6-terra";

/**
 * Native-OpenAI models, keyed by id. Each entry declares its API surface and pricing together; add
 * an entry (or update its rate) when a model is swapped in or its published price changes. Prices are USD per
 * 1M tokens. Shared by the `classifier` and `reporter` capability keys, which each resolve one id from here.
 */
const CLASSIFIER_MODELS: Record<string, ClassifierModel> = {
    "gpt-5.5": {
        createModel: (openai) => openai.chat("gpt-5.5"),
        pricing: inputCacheCostFunction({ inputCostPerM: 5, cachedInputCostPerM: 0.5, outputCostPerM: 30 }),
    },
    "gpt-5.6-luna": {
        createModel: (openai) => openai.responses("gpt-5.6-luna"),
        pricing: inputCacheCostFunction({ inputCostPerM: 1, cachedInputCostPerM: 0.1, outputCostPerM: 6 }),
    },
    "gpt-5.6-terra": {
        createModel: (openai) => openai.responses("gpt-5.6-terra"),
        pricing: inputCacheCostFunction({ inputCostPerM: 2.5, cachedInputCostPerM: 0.25, outputCostPerM: 15 }),
    },
};

/**
 * Open a metered model session. Reuses @autonoma/ai's ModelRegistry (providers, middleware, monitoring,
 * cost tracking) for the shared OpenRouter Gemini-Flash model, and registers a LOCAL native-OpenAI entry
 * for the gpt-5.6-luna classifier (investigation-specific, so it stays out of the shared registry). The OpenAI
 * key is injected; OpenRouter/Gemini/Groq keys are read by @autonoma/ai from its own env.
 */
export function openModelSession(config: InvestigationModelConfig): ModelSession {
    const openai = createOpenAI({ apiKey: config.openaiApiKey });
    const classifierEntry = resolveNativeEntry(
        openai,
        config.classifierModelId ?? DEFAULT_CLASSIFIER_MODEL,
        "classifier",
    );
    const reporterEntry = resolveNativeEntry(openai, config.reporterModelId ?? DEFAULT_REPORTER_MODEL, "reporter");

    const registry = new ModelRegistry<InvestigationModelName>({
        models: {
            "smart-visual": OPENROUTER_MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW,
            classifier: classifierEntry,
            reporter: reporterEntry,
        },
    });
    const costCollector = new CostCollector();

    return {
        getModel: (options) => registry.getModel(options, costCollector),
        costCollector,
    };
}

/** Resolve one native-OpenAI capability key to a {@link ModelEntry}, throwing a clear error on an unknown id. */
function resolveNativeEntry(openai: OpenAIProvider, modelId: string, capability: string): ModelEntry {
    const model = CLASSIFIER_MODELS[modelId];
    if (!model) {
        throw new Error(
            `Unknown ${capability} model id "${modelId}". Valid ids: ${Object.keys(CLASSIFIER_MODELS).join(", ")}`,
        );
    }
    return {
        createModel: () => model.createModel(openai),
        pricing: model.pricing,
    };
}
