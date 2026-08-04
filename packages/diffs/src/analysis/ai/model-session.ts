import { createOpenAI } from "@ai-sdk/openai";
import {
    type CostFunction,
    CostCollector,
    inputCacheCostFunction,
    type LanguageModel,
    MODEL_ENTRIES,
    type ModelEntry,
    type ModelOptions,
    ModelRegistry,
    OPENROUTER_MODEL_ENTRIES,
    type VideoModel,
} from "@autonoma/ai";

/**
 * Capability-named registry keys (following the engine's `{fast,smart,genius}-{visual,text}` convention).
 * - `smart-video`: the vision model behind the deterministic probes and the `analyze_video` tool (MiniMax M3
 *   via OpenRouter). It reads literal on-screen values (a `-$350` sign, a card colour) far more reliably than a
 *   general vision model, which is what the probes need; it also invents error states, so the prompt treats its
 *   scans as findings to verify rather than as verdicts.
 * - `classifier`: the higher-quality final classifier (native OpenAI gpt-5.6-luna - it needs the native
 *   provider because it fails structured output through OpenRouter).
 * - `reporter`: the Reporter agent's model - it must BOTH read screenshots (vision) AND reason across
 *   findings/issues/time, so it sits at a stronger native OpenAI gpt-5.6 tier.
 * - `impact`: the Impact Analysis selector (`DiffsAgent`) - a text-only codebase-exploration loop over the diff
 *   and the suite, deciding which tests the run investigates at all. Native OpenAI, like the classifier.
 */
export type InvestigationModelName = "smart-video" | "classifier" | "reporter" | "impact";

export interface InvestigationModelConfig {
    openaiApiKey: string;
    /** Override the classifier model id (default gpt-5.6-luna). */
    classifierModelId?: string;
    /** Override the Reporter model id (default gpt-5.6-terra - the stronger vision+reasoning tier). */
    reporterModelId?: string;
    /** Override the Impact Analysis model id (default gpt-5.6-luna). */
    impactModelId?: string;
    /** Override the `analyze_video` model id (default minimax/minimax-m3), to revert without a code change. */
    videoModelId?: string;
}

/** A per-run, metered facade over the @autonoma/ai model registry (mirrors the diffs ModelSession). */
export interface ModelSession {
    getModel(options: ModelOptions<InvestigationModelName>): LanguageModel;
    /**
     * The model paired with the {@link VideoUploader} its registry entry declares. Acquiring a video model this
     * way IS the capability check - an entry with no uploader throws rather than failing later at the provider.
     */
    getVideoModel(options: ModelOptions<InvestigationModelName>): VideoModel;
    readonly costCollector: CostCollector;
}

type OpenAIProvider = ReturnType<typeof createOpenAI>;

/**
 * One native-OpenAI model, bundling the two things that vary per model: how to instantiate it
 * (Responses API vs Chat Completions) and its published pricing - the same way @autonoma/ai's {@link ModelEntry}
 * keeps createModel and pricing together so they can never drift apart.
 */
interface NativeOpenAIModel {
    createModel: (openai: OpenAIProvider) => LanguageModel;
    pricing: CostFunction;
}

const DEFAULT_CLASSIFIER_MODEL = "gpt-5.6-luna";
const DEFAULT_REPORTER_MODEL = "gpt-5.6-terra";
const DEFAULT_IMPACT_MODEL = "gpt-5.6-luna";
const DEFAULT_VIDEO_MODEL = "minimax/minimax-m3";

/**
 * The video-capable models `smart-video` can resolve to, keyed by OpenRouter id, so the video model is
 * revertible through config rather than a deploy. Both route through OpenRouter, which rejects webm - the
 * caller must hand these models mp4 (see the classify activity's transcode of pre-optimizer recordings).
 */
const VIDEO_MODELS: Record<string, ModelEntry> = {
    "minimax/minimax-m3": MODEL_ENTRIES.MINIMAX_M3,
    "google/gemini-3-flash-preview": OPENROUTER_MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW,
};

/**
 * Native-OpenAI models, keyed by id. Each entry declares its API surface and pricing together; add
 * an entry (or update its rate) when a model is swapped in or its published price changes. Prices are USD per
 * 1M tokens. Every native-OpenAI capability key resolves one id from here.
 */
const NATIVE_OPENAI_MODELS: Record<string, NativeOpenAIModel> = {
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
 * cost tracking) for the shared OpenRouter-routed vision models, and registers LOCAL native-OpenAI entries
 * for the reasoning capabilities (analysis-specific, so they stay out of the shared registry). The OpenAI
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
    const impactEntry = resolveNativeEntry(openai, config.impactModelId ?? DEFAULT_IMPACT_MODEL, "impact");

    const registry = new ModelRegistry<InvestigationModelName>({
        models: {
            "smart-video": resolveVideoEntry(config.videoModelId ?? DEFAULT_VIDEO_MODEL),
            classifier: classifierEntry,
            reporter: reporterEntry,
            impact: impactEntry,
        },
    });
    const costCollector = new CostCollector();

    return {
        getModel: (options) => registry.getModel(options, costCollector),
        getVideoModel: (options) => registry.getVideoModel(options, costCollector),
        costCollector,
    };
}

/** Resolve one native-OpenAI capability key to a {@link ModelEntry}, throwing a clear error on an unknown id. */
function resolveNativeEntry(openai: OpenAIProvider, modelId: string, capability: string): ModelEntry {
    const model = NATIVE_OPENAI_MODELS[modelId];
    if (!model) {
        throw new Error(
            `Unknown ${capability} model id "${modelId}". Valid ids: ${Object.keys(NATIVE_OPENAI_MODELS).join(", ")}`,
        );
    }
    return {
        createModel: () => model.createModel(openai),
        pricing: model.pricing,
    };
}

/** Resolve the `smart-video` capability key to one of the {@link VIDEO_MODELS}, throwing on an unknown id. */
function resolveVideoEntry(modelId: string): ModelEntry {
    const entry = VIDEO_MODELS[modelId];
    if (!entry) {
        throw new Error(`Unknown video model id "${modelId}". Valid ids: ${Object.keys(VIDEO_MODELS).join(", ")}`);
    }
    return entry;
}
