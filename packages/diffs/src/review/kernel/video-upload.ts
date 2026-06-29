import type { UploadedVideo, VideoUploader } from "@autonoma/ai";
import { logger } from "@autonoma/logger";

export interface VideoDownloader {
    downloadVideo(key: string): Promise<Buffer>;
}

export async function tryUploadVideo(
    videoKey: string | undefined,
    downloader: VideoDownloader,
    uploader: VideoUploader,
): Promise<UploadedVideo | undefined> {
    if (videoKey == null) {
        logger.info("Skipping video upload - no video key available");
        return undefined;
    }

    let videoBuffer: Buffer;
    try {
        videoBuffer = await downloader.downloadVideo(videoKey);
    } catch (error) {
        logger.error("Failed to download video, continuing without it", error);
        return undefined;
    }

    let uploaded: UploadedVideo;
    try {
        uploaded = await uploader.uploadVideo({
            data: { type: "buffer", buffer: new Uint8Array(videoBuffer).buffer as ArrayBuffer },
            mimeType: "video/webm",
        });
    } catch (error) {
        logger.error("Failed to upload video to GenAI, continuing without it", error);
        return undefined;
    }

    logger.info("Video uploaded successfully", { uri: uploaded.uri });
    return uploaded;
}
