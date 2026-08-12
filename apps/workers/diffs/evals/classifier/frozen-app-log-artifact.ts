import { createHash } from "node:crypto";
import type { Logger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import { appLogArtifactLocation } from "./app-log-artifact-location";
import { type FrozenAppLogArtifact, type FrozenAppLogWindow, frozenAppLogWindowSchema } from "./classifier-input";

const JSON_CONTENT_TYPE = "application/json";

export class FrozenAppLogArtifactError extends Error {
    constructor(
        message: string,
        public readonly key: string,
    ) {
        super(message);
    }
}

export class FrozenAppLogArtifactStore {
    public static readonly bucket = appLogArtifactLocation.bucket;

    private readonly logger: Logger;

    constructor(
        private readonly storage: StorageProvider,
        logger: Logger,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    public async write(classificationId: string, window: FrozenAppLogWindow): Promise<FrozenAppLogArtifact> {
        const data = Buffer.from(`${JSON.stringify(window)}\n`, "utf-8");
        const sha256 = checksum(data);
        const key = `${appLogArtifactLocation.prefix}/${classificationId}-${sha256}.json`;

        this.logger.info("Uploading frozen app-log artifact", {
            extra: { classificationId, key, lines: window.lines.length, windowTruncated: window.windowTruncated },
        });
        try {
            const storedKey = await this.storage.upload(key, data, JSON_CONTENT_TYPE);
            const artifact: FrozenAppLogArtifact = {
                key: storedKey,
                namespace: window.namespace,
                lineCount: window.lines.length,
                windowTruncated: window.windowTruncated,
                sha256,
            };
            this.logger.info("Uploaded frozen app-log artifact", {
                extra: { classificationId, key: artifact.key, lines: artifact.lineCount },
            });
            return artifact;
        } catch (err) {
            this.logger.error("Failed to upload frozen app-log artifact", err, { extra: { classificationId, key } });
            throw new FrozenAppLogArtifactError(`Could not upload frozen app logs: ${errorMessage(err)}`, key);
        }
    }

    public async read(artifact: FrozenAppLogArtifact): Promise<FrozenAppLogWindow> {
        this.logger.info("Downloading frozen app-log artifact", { extra: { key: artifact.key } });
        let data: Buffer;
        try {
            data = await this.storage.download(artifact.key);
        } catch (err) {
            this.logger.error("Failed to download frozen app-log artifact", err, { extra: { key: artifact.key } });
            throw new FrozenAppLogArtifactError(
                `Could not download frozen app logs: ${errorMessage(err)}`,
                artifact.key,
            );
        }

        if (checksum(data) !== artifact.sha256) {
            this.logger.error("Frozen app-log artifact checksum did not match", {
                extra: { key: artifact.key },
            });
            throw new FrozenAppLogArtifactError("Frozen app logs failed their integrity check", artifact.key);
        }

        let parsed: FrozenAppLogWindow;
        try {
            parsed = frozenAppLogWindowSchema.parse(JSON.parse(data.toString("utf-8")));
        } catch (err) {
            this.logger.error("Frozen app-log artifact could not be parsed", err, { extra: { key: artifact.key } });
            throw new FrozenAppLogArtifactError(`Frozen app logs were malformed: ${errorMessage(err)}`, artifact.key);
        }

        if (
            parsed.namespace !== artifact.namespace ||
            parsed.lines.length !== artifact.lineCount ||
            parsed.windowTruncated !== artifact.windowTruncated
        ) {
            this.logger.error("Frozen app-log artifact metadata did not match", { extra: { key: artifact.key } });
            throw new FrozenAppLogArtifactError("Frozen app logs did not match their committed metadata", artifact.key);
        }

        this.logger.info("Downloaded frozen app-log artifact", {
            extra: { key: artifact.key, lines: parsed.lines.length, windowTruncated: parsed.windowTruncated },
        });
        return parsed;
    }
}

function checksum(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
