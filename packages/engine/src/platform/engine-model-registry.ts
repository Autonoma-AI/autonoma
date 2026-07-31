import { type CostCollector, MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";

// Slots shared by every platform's registry. Kept as one source so web and mobile can't
// silently drift on the non-`smart-visual` models; each platform spreads this and overrides only
// what differs (`smart-visual`, and web's extra `pointer`).
const SHARED_MODEL_SLOTS = {
    "fast-visual": MODEL_ENTRIES.MINISTRAL_8B,
    "fast-text": MODEL_ENTRIES.GPT_OSS_120B,
} as const;

export type EngineModelRegistry = ModelRegistry<"fast-visual" | "smart-visual" | "fast-text">;

export function createEngineModelRegistry(costCollector?: CostCollector): EngineModelRegistry {
    return new ModelRegistry({
        models: {
            ...SHARED_MODEL_SLOTS,
            "smart-visual": MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW,
        },
        monitoring: costCollector?.createMonitoringCallbacks(),
    });
}

/**
 * Web registry. Adds a dedicated `pointer` slot (grounding) separate from `smart-visual`
 * (agent-loop / assert / text-extraction) so the two can use different models: Gemini-3.5-flash-lite
 * drives the loop, Qwen3-VL-32B does the grounding. Web-only - mobile stays on
 * {@link createEngineModelRegistry}.
 */
export type WebEngineModelRegistry = ModelRegistry<"fast-visual" | "smart-visual" | "fast-text" | "pointer">;

export function createWebEngineModelRegistry(costCollector?: CostCollector): WebEngineModelRegistry {
    return new ModelRegistry({
        models: {
            ...SHARED_MODEL_SLOTS,
            "smart-visual": MODEL_ENTRIES.GEMINI_3_5_FLASH_LITE,
            pointer: MODEL_ENTRIES.QWEN3_VL_32B,
        },
        monitoring: costCollector?.createMonitoringCallbacks(),
    });
}
