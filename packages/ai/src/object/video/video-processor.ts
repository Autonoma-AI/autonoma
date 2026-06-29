import { external } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import { FileState, type GoogleGenAI, type File as GoogleGenAIFile } from "@google/genai";
import type { VideoInput } from "./video-input";

export class VideoUploadFailedError extends Error {
    constructor(cause: Error) {
        super("Failed to upload video", { cause });
    }
}

export class VideoUploadTimedOutError extends Error {
    constructor() {
        super("Video upload timed out");
    }
}

export class VideoUploadGetStateFailedError extends Error {
    constructor(cause: Error) {
        super("Failed to get upload state", { cause });
    }
}

export class MalformedVideoUploadResultError extends Error {
    constructor(public readonly result: GoogleGenAIFile) {
        const { uri, mimeType } = result;
        super(`The video upload result is malformed: ${JSON.stringify({ uri, mimeType })}`);
    }
}

function getVideoData({ data }: VideoInput): string | Blob {
    switch (data.type) {
        case "buffer":
            return new Blob([data.buffer]);
        case "file":
            return data.path;
    }
}

export interface UploadedVideo {
    /** The URI of the uploaded video. A provider file reference (e.g. Google Files API) or a data URL. */
    uri: string;
    /** The MIME type of the uploaded video */
    mimeType: VideoInput["mimeType"];
}

/**
 * Turns raw video bytes into an {@link UploadedVideo} reference a message can carry.
 *
 * {@link VideoProcessor} is the Google-Files-API implementation; other implementations (e.g. an
 * inline data-URL uploader for OpenRouter-routed models) can be substituted wherever a reviewer
 * accepts video, so video delivery is not bound to Google.
 */
export interface VideoUploader {
    uploadVideo(videoInput: VideoInput): Promise<UploadedVideo>;
}

export interface VideoUploadOptions {
    /** The interval to poll for upload completion */
    pollInterval?: number;
    /** Maximum time to wait for upload completion */
    timeout?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * A processor for video data.
 *
 * This is a light wrapper around the GoogleGenAI class that uploads the video using the Files API, and returns a
 * URL to the uploaded video.
 */
export class VideoProcessor implements VideoUploader {
    private readonly logger: Logger;

    constructor(
        private readonly genAI: GoogleGenAI,
        private readonly options: VideoUploadOptions = {},
    ) {
        this.logger = logger.child({
            name: this.constructor.name,
        });
    }

    async uploadVideo(videoInput: VideoInput): Promise<UploadedVideo> {
        this.logger.info("Uploading video", { mimeType: videoInput.mimeType });

        const uploadResult = await external(
            () =>
                this.genAI.files.upload({
                    file: getVideoData(videoInput),
                    config: { mimeType: videoInput.mimeType },
                }),
            { wrapper: (error) => new VideoUploadFailedError(error) },
        );

        await this.waitForUploadCompletion(uploadResult);

        if (uploadResult.uri == null || uploadResult.mimeType == null)
            throw new MalformedVideoUploadResultError(uploadResult);

        return { uri: uploadResult.uri, mimeType: videoInput.mimeType };
    }

    private async waitForUploadCompletion(uploadResult: GoogleGenAIFile): Promise<void> {
        const { pollInterval = DEFAULT_POLL_INTERVAL_MS, timeout = DEFAULT_TIMEOUT_MS } = this.options;

        const startTime = Date.now();
        let uploadState = uploadResult.state;

        while (uploadState === FileState.PROCESSING && Date.now() - startTime < timeout) {
            this.logger.info("Waiting for upload completion", {
                pollInterval,
                msWaited: Date.now() - startTime,
            });
            await new Promise((resolve) => setTimeout(resolve, pollInterval));

            const getResult = await external(
                // biome-ignore lint/style/noNonNullAssertion: I think this can't be null (trusting the API docs)
                () => this.genAI.files.get({ name: uploadResult.name! }),
                { wrapper: (error) => new VideoUploadGetStateFailedError(error) },
            );

            uploadState = getResult.state;
        }

        if (uploadState === FileState.PROCESSING) throw new VideoUploadTimedOutError();
        if (uploadState === FileState.FAILED)
            throw new VideoUploadFailedError(new Error("Failure while waiting for upload completion"));
    }
}
