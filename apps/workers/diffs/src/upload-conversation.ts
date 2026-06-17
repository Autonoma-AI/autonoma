import type { Logger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import type { ModelMessage } from "ai";

interface UploadConversationParams {
    storage: StorageProvider;
    snapshotId: string;
    phase: "analysis";
    conversation: ModelMessage[];
    logger: Logger;
}

/**
 * Upload a diffs conversation to S3 and return its URL. Returns undefined
 * on failure - the conversation is for debugging and must not fail the flow.
 */
export async function uploadConversation({
    storage,
    snapshotId,
    phase,
    conversation,
    logger,
}: UploadConversationParams): Promise<string | undefined> {
    if (conversation.length === 0) {
        logger.info("Skipping conversation upload: empty conversation", { phase });
        return undefined;
    }

    const key = `diffs-job/${snapshotId}/${phase}-conversation.json`;

    try {
        logger.info("Uploading diffs conversation to S3", { phase, key, messageCount: conversation.length });
        const url = await storage.upload(key, Buffer.from(JSON.stringify(conversation)));
        logger.info("Diffs conversation uploaded", { phase, url });
        return url;
    } catch (error) {
        logger.warn("Failed to upload diffs conversation", { phase, key, error });
        return undefined;
    }
}
