import { type ModelSession, openModelSession } from "@autonoma/diffs/analysis";
import { S3Storage } from "@autonoma/storage";
import { env } from "./env";

/**
 * Open a fresh, metered model session for one analysis-pipeline activity (reuses @autonoma/ai's registry:
 * smart-visual Gemini-Flash via OpenRouter + the native-OpenAI gpt-5.6-luna classifier). Throws if the
 * classifier key is not configured on this worker - the analysis shadow is gated by ANALYSIS_SHADOW_ENABLED
 * on the API side, so the key is only needed once the shadow is deliberately turned on; each activity contains
 * this error, so a misconfigured worker fails the shadow rather than the diffs pipeline.
 */
export function createModelSession(): ModelSession {
    if (env.OPENAI_API_KEY == null) {
        throw new Error(
            "OPENAI_API_KEY is not configured on the diffs worker; the analysis classifier cannot run. " +
                "Provision it before enabling ANALYSIS_SHADOW_ENABLED.",
        );
    }
    return openModelSession({
        openaiApiKey: env.OPENAI_API_KEY,
        classifierModelId: env.INVESTIGATION_CLASSIFIER_MODEL,
    });
}

let storageSingleton: S3Storage | undefined;

/** The S3 storage client (run-media download + clip upload), constructed once. */
export function getStorage(): S3Storage {
    if (storageSingleton == null) {
        storageSingleton = S3Storage.createFromEnv();
    }
    return storageSingleton;
}
