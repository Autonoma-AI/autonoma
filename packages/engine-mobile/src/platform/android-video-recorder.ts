import { writeFile } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { VideoRecorder } from "@autonoma/engine";
import type { Browser } from "webdriverio";
import { runAppium } from "./drivers/appium-error";
import { NoVideoPathError } from "./ios-video-recorder";

export class FailedToWriteVideoFileError extends Error {
    constructor(public readonly error: Error) {
        super(`Failed to write video file: ${error.message}`);
    }
}

export class AndroidVideoRecorder extends VideoRecorder {
    private videoPath?: string;

    constructor(private readonly driver: Browser) {
        super();
    }

    protected async startRecording(): Promise<void> {
        await runAppium(() =>
            this.driver.startRecordingScreen({
                // Max allowed by Android is 1800 seconds (30 min)
                timeLimit: 1800,
            }),
        );
    }

    protected async stopRecording(): Promise<void> {
        this.logger.info("Stopping mobile video recording...");

        const recordingBase64 = await runAppium(() => this.driver.stopRecordingScreen());

        this.logger.info("Recording stopped, converting to buffer...", { length: recordingBase64.length });
        const buff = Buffer.from(recordingBase64, "base64");

        const tmpDir = os.tmpdir();
        const videoPath = path.join(tmpDir, `video-${Date.now()}.mp4`);

        try {
            await writeFile(videoPath, buff);
        } catch (error) {
            throw new FailedToWriteVideoFileError(error instanceof Error ? error : new Error(String(error)));
        }

        this.videoPath = videoPath;
        this.logger.info("Video file written successfully", { videoPath });
    }

    protected async computeVideoPath(): Promise<string> {
        if (this.videoPath == null) throw new NoVideoPathError();
        return this.videoPath;
    }
}
