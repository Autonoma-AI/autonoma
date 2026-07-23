import type { UploadedVideo, VideoInput, VideoUploader } from "@autonoma/ai";
import { logger } from "@autonoma/logger";

export interface VideoDownloader {
    downloadVideo(key: string): Promise<Buffer>;
}

/**
 * Upload the run recording to the video model. Prefers the dead-time-stripped `optimizedVideoKey` (an mp4, a
 * fraction of the frames the model bills) and falls back to the original webm. Best-effort: any failure returns
 * `undefined` so review continues without the video.
 */
export async function tryUploadVideo(
    videoKey: string | undefined,
    optimizedVideoKey: string | undefined,
    downloader: VideoDownloader,
    uploader: VideoUploader,
): Promise<UploadedVideo | undefined> {
    const source = await resolveSource(videoKey, optimizedVideoKey, downloader);
    if (source == null) return undefined;

    try {
        const uploaded = await uploader.uploadVideo(source);
        logger.info("Video uploaded successfully", { uri: uploaded.uri, mimeType: source.mimeType });
        return uploaded;
    } catch (error) {
        logger.error("Failed to upload video to GenAI, continuing without it", error);
        return undefined;
    }
}

async function resolveSource(
    videoKey: string | undefined,
    optimizedVideoKey: string | undefined,
    downloader: VideoDownloader,
): Promise<VideoInput | undefined> {
    if (optimizedVideoKey != null) {
        const optimized = await tryDownload(optimizedVideoKey, "video/mp4", downloader);
        if (optimized != null) return optimized;
    }
    if (videoKey != null) {
        return await tryDownload(videoKey, "video/webm", downloader);
    }
    logger.info("Skipping video upload - no video key available");
    return undefined;
}

async function tryDownload(
    key: string,
    mimeType: VideoInput["mimeType"],
    downloader: VideoDownloader,
): Promise<VideoInput | undefined> {
    try {
        const buffer = await downloader.downloadVideo(key);
        return { data: { type: "buffer", buffer: toArrayBuffer(buffer) }, mimeType };
    } catch (error) {
        logger.error("Failed to download video, continuing without it", error);
        return undefined;
    }
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
    const copy = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(copy).set(buffer);
    return copy;
}
