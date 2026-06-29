import { logger as rootLogger } from "@autonoma/logger";

/** MIME types browsers need to play and seek a recording, keyed by file extension. */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
    webm: "video/webm",
    mp4: "video/mp4",
};

/**
 * Resolves the HTTP `Content-Type` for an uploaded recording from its file
 * extension. Object storage otherwise stores videos as
 * `application/octet-stream`, which makes some browsers refuse to seek them.
 */
export function videoContentType(extension: string): string {
    const logger = rootLogger.child({ name: "videoContentType" });
    const normalized = extension.replace(/^\./, "").toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXTENSION[normalized];

    if (contentType == null) {
        logger.warn("Unknown video extension, defaulting to octet-stream", { extra: { extension } });
        return "application/octet-stream";
    }

    return contentType;
}
