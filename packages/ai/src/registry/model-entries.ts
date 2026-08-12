import { GoogleGenAI } from "@google/genai";
import { env } from "../env";
import { InlineMp4VideoUploader } from "../object/video/inline-mp4-video-uploader";
import { VideoProcessor, type VideoUploader } from "../object/video/video-processor";
import { type CostFunction, inputCacheCostFunction, simpleCostFunction } from "./costs";
import type { LanguageModel } from "./model-registry";
import { googleProvider, groqProvider, openRouterProvider } from "./providers";

export interface ModelEntry {
    createModel: () => LanguageModel;
    pricing: CostFunction;
    /**
     * Factory for the {@link VideoUploader} this model needs to accept video input. Present only on
     * video-capable entries: the model and the uploader its provider requires are declared together
     * here so they can never drift apart. Google models use the Files-API {@link VideoProcessor};
     * OpenRouter-routed models use the inline-mp4 {@link InlineMp4VideoUploader}.
     */
    createUploader?: () => VideoUploader;
}

/**
 * OpenRouter serves `minimax/minimax-m3` from several upstreams that do NOT agree on video, so routing is
 * pinned rather than left to OpenRouter's load balancing. Probed with a ~3-4 MB run recording, only deepinfra
 * and morph actually receive the `video_url` part (~11.8k prompt tokens) and read the on-screen value
 * correctly; novita / atlas-cloud / gmicloud silently DROP it (under ~400 prompt tokens) and answer "I don't
 * see any video", together receives it but misreads the value, and venice / parasail / minimax error or
 * rate-limit. A silently video-blind answer is the worst possible outcome for a vision tool - it reads as
 * confident evidence that nothing was on screen.
 *
 * `only` hard-restricts to the two upstreams that read video (OpenRouter honours it regardless of
 * `allow_fallbacks`), and `allow_fallbacks: false` keeps a busy pin from spilling onto a video-blind one.
 * `order` prefers morph: its full-recording reads settle in ~30s where deepinfra's run ~2-4x slower and can
 * cross the classifier's per-read timeout, but deepinfra stays second-in-order as a live backup. Re-probe
 * before widening this list.
 */
const MINIMAX_M3_ROUTING = {
    provider: { only: ["deepinfra", "morph"], order: ["morph", "deepinfra"], allow_fallbacks: false },
};
// Only route Qwen to providers that support the structured-output param the object detector sends.
const QWEN3_VL_32B_ROUTING = { provider: { require_parameters: true } };

export const MODEL_ENTRIES: Record<
    | "GEMINI_3_FLASH_PREVIEW"
    | "GEMINI_3_5_FLASH_LITE"
    | "QWEN3_VL_32B"
    | "MINISTRAL_8B"
    | "GPT_OSS_120B"
    | "MINIMAX_M3",
    ModelEntry
> = {
    GEMINI_3_FLASH_PREVIEW: {
        createModel: () => googleProvider.getModel("gemini-3-flash-preview"),
        pricing: inputCacheCostFunction({
            inputCostPerM: 0.5,
            cachedInputCostPerM: 0.05,
            outputCostPerM: 3,
        }),
        createUploader: () => new VideoProcessor(new GoogleGenAI({ apiKey: env.GEMINI_API_KEY })),
    },
    GEMINI_3_5_FLASH_LITE: {
        createModel: () => googleProvider.getModel("gemini-3.5-flash-lite"),
        pricing: inputCacheCostFunction({
            inputCostPerM: 0.3,
            cachedInputCostPerM: 0.03,
            outputCostPerM: 2.5,
        }),
        createUploader: () => new VideoProcessor(new GoogleGenAI({ apiKey: env.GEMINI_API_KEY })),
    },
    QWEN3_VL_32B: {
        createModel: () =>
            openRouterProvider.getModel("qwen/qwen3-vl-32b-instruct", { extraBody: QWEN3_VL_32B_ROUTING }),
        pricing: simpleCostFunction({
            inputCostPerM: 0.104,
            outputCostPerM: 0.416,
        }),
    },
    MINISTRAL_8B: {
        createModel: () => openRouterProvider.getModel("mistralai/ministral-8b-2512"),
        pricing: simpleCostFunction({
            inputCostPerM: 0.15,
            outputCostPerM: 0.15,
        }),
    },
    GPT_OSS_120B: {
        createModel: () => groqProvider.getModel("openai/gpt-oss-120b"),
        pricing: inputCacheCostFunction({
            inputCostPerM: 0.15,
            cachedInputCostPerM: 0.075,
            outputCostPerM: 0.6,
        }),
    },
    MINIMAX_M3: {
        createModel: () => openRouterProvider.getModel("minimax/minimax-m3", { extraBody: MINIMAX_M3_ROUTING }),
        // Priced from OpenRouter's minimax/minimax-m3 listing. Cache-read tokens ($0.06/M) are not
        // modelled (OpenRouter per-call cache reporting is not relied on) - a slight overestimate.
        pricing: simpleCostFunction({
            inputCostPerM: 0.3,
            outputCostPerM: 1.2,
        }),
        createUploader: () => new InlineMp4VideoUploader(),
    },
};

export const OPENROUTER_MODEL_ENTRIES: Record<"GEMINI_3_FLASH_PREVIEW" | "MINISTRAL_8B" | "GPT_OSS_120B", ModelEntry> =
    {
        GEMINI_3_FLASH_PREVIEW: {
            createModel: () => openRouterProvider.getModel("google/gemini-3-flash-preview"),
            pricing: inputCacheCostFunction({
                inputCostPerM: 0.5,
                cachedInputCostPerM: 0.05,
                outputCostPerM: 3,
            }),
            createUploader: () => new InlineMp4VideoUploader(),
        },
        MINISTRAL_8B: {
            createModel: () => openRouterProvider.getModel("meta-llama/llama-4-maverick"),
            pricing: simpleCostFunction({
                inputCostPerM: 0.2,
                outputCostPerM: 0.6,
            }),
        },
        GPT_OSS_120B: {
            createModel: () => openRouterProvider.getModel("openai/gpt-oss-120b"),
            pricing: inputCacheCostFunction({
                inputCostPerM: 0.15,
                cachedInputCostPerM: 0.075,
                outputCostPerM: 0.6,
            }),
        },
    };
