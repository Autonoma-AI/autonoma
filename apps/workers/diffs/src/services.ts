import { type ModelSession, openModelSession } from "@autonoma/diffs/analysis";
import { S3Storage } from "@autonoma/storage";
import { env } from "./env";

/**
 * Open a fresh, metered model session for one analysis-pipeline activity.
 *
 * Throws if the OpenAI key is not configured on this worker - analysis is every org's PR analysis, so the key
 * is required in practice; each activity contains this error, so a misconfigured worker fails the analysis run
 * rather than taking down the worker.
 */
export function createModelSession(): ModelSession {
    if (env.OPENAI_API_KEY == null) {
        throw new Error(
            "OPENAI_API_KEY is not configured on the diffs worker; the analysis pipeline cannot run. " +
                "Provision it on the diffs worker.",
        );
    }
    return openModelSession({
        openaiApiKey: env.OPENAI_API_KEY,
        classifierModelId: env.INVESTIGATION_CLASSIFIER_MODEL,
        videoModelId: env.INVESTIGATION_VIDEO_MODEL,
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
