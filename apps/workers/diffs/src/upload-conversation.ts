import type { Logger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import type { ModelMessage } from "ai";

interface UploadConversationParams {
    storage: StorageProvider;
    snapshotId: string;
    phase: "analysis" | "classify" | "reporter";
    /**
     * A per-conversation discriminator folded into the key so runs within one snapshot do not collide. The
     * `analysis` and `reporter` phases are one-per-snapshot and omit it; the `classify` phase runs once per
     * investigated test, so it passes the test slug.
     */
    slug?: string;
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
    slug,
    conversation,
    logger,
}: UploadConversationParams): Promise<string | undefined> {
    if (conversation.length === 0) {
        logger.info("Skipping conversation upload: empty conversation", { phase, slug });
        return undefined;
    }

    const suffix = slug != null ? `${phase}-${slug}` : phase;
    const key = `diffs-job/${snapshotId}/${suffix}-conversation.json`;

    try {
        logger.info("Uploading diffs conversation to S3", { phase, slug, key, messageCount: conversation.length });
        const url = await storage.upload(key, Buffer.from(JSON.stringify(conversation)));
        logger.info("Diffs conversation uploaded", { phase, slug, url });
        return url;
    } catch (error) {
        logger.warn("Failed to upload diffs conversation", { phase, slug, key, error });
        return undefined;
    }
}
