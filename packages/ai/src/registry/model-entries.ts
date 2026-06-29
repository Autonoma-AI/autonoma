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

export const MODEL_ENTRIES: Record<
    "GEMINI_3_FLASH_PREVIEW" | "MINISTRAL_8B" | "GPT_OSS_120B" | "MINIMAX_M3",
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
        createModel: () => openRouterProvider.getModel("minimax/minimax-m3"),
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
