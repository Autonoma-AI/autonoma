import type { EvidenceLoader } from "@autonoma/diffs";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

/**
 * Thrown when an S3 key referenced by a captured reviewer case can no longer be
 * resolved - typically because the bucket has been rotated or the object expired.
 * Capture refuses to freeze a case in this state; the eval suite skips such a
 * case with a warning rather than red-failing, mirroring `UnfetchableShaError`.
 */
export class MissingEvidenceError extends Error {
    constructor(
        public readonly key: string,
        public readonly kind: "screenshot" | "video",
        options?: { cause?: unknown },
    ) {
        super(`${kind} evidence ${key} is not downloadable`, options);
        this.name = "MissingEvidenceError";
    }
}

export interface EvidenceKeys {
    /** All step screenshot keys (before/after, deduped). */
    screenshots: string[];
    /** Optional final screenshot key (not always present). */
    finalScreenshot?: string;
    /** Optional video key (not always present). */
    video?: string;
}

export interface ProbeEvidenceOptions {
    logger?: Logger;
}

/**
 * Walk every S3 key a reviewer case references and verify each is downloadable
 * via the production loader. Throws {@link MissingEvidenceError} on the first
 * miss so callers can convert a missing-evidence case into a clean skip the
 * same way they do for an unfetchable SHA.
 *
 * Does not retain the downloaded bytes - the production loader handles its own
 * fetching at agent run time; this is purely a pre-flight existence check.
 */
export async function probeEvidence(
    keys: EvidenceKeys,
    evidenceLoader: EvidenceLoader,
    options: ProbeEvidenceOptions = {},
): Promise<void> {
    const logger = (options.logger ?? rootLogger).child({ name: "probeEvidence" });

    const screenshotKeys = uniqueDefined([...keys.screenshots, keys.finalScreenshot]);

    logger.info("Probing evidence keys", {
        extra: { screenshotCount: screenshotKeys.length, hasVideo: keys.video != null },
    });

    for (const key of screenshotKeys) {
        await probeScreenshot(key, evidenceLoader, logger);
    }

    if (keys.video != null) {
        await probeVideo(keys.video, evidenceLoader, logger);
    }

    logger.info("All evidence keys reachable");
}

async function probeScreenshot(key: string, loader: EvidenceLoader, logger: Logger): Promise<void> {
    try {
        await loader.loadScreenshot(key);
    } catch (err) {
        logger.warn("Screenshot key not downloadable", { extra: { key, err } });
        throw new MissingEvidenceError(key, "screenshot", { cause: err });
    }
}

async function probeVideo(key: string, loader: EvidenceLoader, logger: Logger): Promise<void> {
    try {
        await loader.downloadVideo(key);
    } catch (err) {
        logger.warn("Video key not downloadable", { extra: { key, err } });
        throw new MissingEvidenceError(key, "video", { cause: err });
    }
}

function uniqueDefined(values: (string | undefined)[]): string[] {
    return Array.from(new Set(values.filter((v): v is string => v != null)));
}
