import type { Logger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import type { ModelMessage } from "ai";

interface UploadConversationParams {
    storage: StorageProvider;
    iterationId: string;
    conversation: ModelMessage[];
    logger: Logger;
}

/**
 * Upload a HealingAgent conversation to S3 and return its URL. Returns
 * undefined on failure - the conversation is for debugging and must not
 * fail the activity.
 */
export async function uploadHealingConversation({
    storage,
    iterationId,
    conversation,
    logger,
}: UploadConversationParams): Promise<string | undefined> {
    if (conversation.length === 0) {
        logger.info("Skipping conversation upload: empty conversation");
        return undefined;
    }

    const key = `refinement-loop/iteration-${iterationId}/healing-conversation.json`;

    try {
        logger.info("Uploading healing conversation to S3", { key, messageCount: conversation.length });
        const url = await storage.upload(key, Buffer.from(JSON.stringify(conversation)));
        logger.info("Healing conversation uploaded", { url });
        return url;
    } catch (error) {
        logger.warn("Failed to upload healing conversation", { key, error });
        return undefined;
    }
}
