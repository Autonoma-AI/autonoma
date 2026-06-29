import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { logger as rootLogger } from "@autonoma/logger";
import type { VideoInput } from "./video-input";
import type { UploadedVideo, VideoUploader } from "./video-processor";

const execFileAsync = promisify(execFile);

/**
 * {@link VideoUploader} for non-Google models routed through OpenRouter.
 *
 * OpenRouter's `video_url` content part accepts mp4 base64 but rejects webm, and the recordings are
 * webm - so the buffer is transcoded to mp4 with ffmpeg and returned as base64. The caller attaches
 * it as a `{ type: "file", data: <base64>, mediaType: "video/mp4" }` part, which
 * `@openrouter/ai-sdk-provider` (>= 2.10) converts into a `video_url` part. This is the non-Google
 * counterpart to {@link import("./video-processor").VideoProcessor} (Google Files API).
 *
 * Requires `ffmpeg` on PATH.
 */
export class InlineMp4VideoUploader implements VideoUploader {
    private readonly logger = rootLogger.child({ name: this.constructor.name });

    async uploadVideo(videoInput: VideoInput): Promise<UploadedVideo> {
        const mp4 = await this.transcodeToMp4(videoInput);
        this.logger.info("Inlined recording as mp4 for non-Google model", { extra: { mp4Bytes: mp4.length } });
        return { uri: mp4.toString("base64"), mimeType: "video/mp4" };
    }

    private async transcodeToMp4(videoInput: VideoInput): Promise<Buffer> {
        const dir = await mkdtemp(join(tmpdir(), "inline-mp4-"));
        const inPath = join(dir, "in");
        const outPath = join(dir, "out.mp4");
        try {
            const inBytes =
                videoInput.data.type === "buffer"
                    ? Buffer.from(videoInput.data.buffer)
                    : await readFile(videoInput.data.path);
            await writeFile(inPath, inBytes);
            await execFileAsync("ffmpeg", [
                "-y",
                "-i",
                inPath,
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-an",
                outPath,
            ]);
            return await readFile(outPath);
        } finally {
            await rm(dir, { recursive: true, force: true }).catch((err) => {
                this.logger.warn("Failed to clean up transcode temp dir", { extra: { dir, err } });
            });
        }
    }
}
