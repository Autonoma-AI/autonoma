import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import type { ScreenshotLoader } from "../../agents/tools/screenshot/screenshot-types";
import type { VideoDownloader } from "./video-upload";

/**
 * Combined loader for the multimedia evidence (step screenshots + recording)
 * a reviewer agent needs from the bytes side. Production wires this to S3 via
 * {@link StorageEvidenceLoader}; evals wire it to the same production loaders
 * so the agent sees identical bytes.
 */
export type EvidenceLoader = ScreenshotLoader & VideoDownloader;

/**
 * Default {@link EvidenceLoader} implementation, backed directly by a
 * {@link StorageProvider}. Production context loaders compose this; eval
 * harnesses construct it directly so they can rehydrate a frozen reviewer
 * context's media exactly the way production does.
 */
export class StorageEvidenceLoader implements EvidenceLoader {
    private readonly logger: Logger;

    constructor(private readonly storage: StorageProvider) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async loadScreenshot(key: string): Promise<Buffer> {
        this.logger.debug("Loading screenshot", { extra: { key } });
        return this.storage.download(key);
    }

    async downloadVideo(key: string): Promise<Buffer> {
        this.logger.debug("Downloading video", { extra: { key } });
        return this.storage.download(key);
    }
}
