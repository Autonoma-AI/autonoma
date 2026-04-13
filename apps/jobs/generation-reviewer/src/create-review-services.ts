import { CostCollector, MODEL_ENTRIES, ModelRegistry, VideoProcessor } from "@autonoma/ai";
import { BugLinker, BugMatcher } from "@autonoma/review";
import { GoogleGenAI } from "@google/genai";
import { env } from "./env";

export function createReviewServices() {
    const costCollector = new CostCollector();
    const registry = new ModelRegistry({
        models: { GEMINI_3_FLASH_PREVIEW: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
        monitoring: costCollector.createMonitoringCallbacks(),
    });

    const model = registry.getModel({ model: "GEMINI_3_FLASH_PREVIEW", tag: "analysis" });

    const genAI = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const videoProcessor = new VideoProcessor(genAI);

    const bugMatcher = new BugMatcher(model);
    const bugLinker = new BugLinker(bugMatcher);

    return { costCollector, model, videoProcessor, bugLinker };
}
