import type { Logger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import type { ModelMessage } from "ai";

interface UploadConversationParams {
    storage: StorageProvider;
    snapshotId: string;
    phase: "analysis" | "classify" | "reporter";
    /**
     * A per-conversation discriminator folded into the key so conversations within one snapshot do not collide.
     * The `analysis` and `reporter` phases are one-per-snapshot and omit it; the `classify` phase runs once per
     * run+classify iteration, so it passes that iteration's generation id - which identifies the run judged, and
     * therefore cannot disagree with the object's contents the way a test slug could.
     */
    generationId?: string;
    conversation: ModelMessage[];
    logger: Logger;
}

/**
 * Upload a diffs conversation to S3 and return its `s3://` URL. Returns undefined on failure - the conversation
 * is for debugging and must never fail the flow (same contract as the run and impact-analysis uploads).
 */
export async function uploadConversation({
    storage,
    snapshotId,
    phase,
    generationId,
    conversation,
    logger,
}: UploadConversationParams): Promise<string | undefined> {
    if (conversation.length === 0) {
        logger.info("Skipping conversation upload: empty conversation", { phase, generationId });
        return undefined;
    }

    const suffix = generationId != null ? `${phase}-${generationId}` : phase;
    const key = `diffs-job/${snapshotId}/${suffix}-conversation.json`;

    try {
        logger.info("Uploading diffs conversation to S3", {
            phase,
            generationId,
            key,
            messageCount: conversation.length,
        });
        const url = await storage.upload(key, Buffer.from(JSON.stringify(conversation)));
        logger.info("Diffs conversation uploaded", { phase, generationId, url });
        return url;
    } catch (error) {
        logger.warn("Failed to upload diffs conversation", { phase, generationId, key, error });
        return undefined;
    }
}
