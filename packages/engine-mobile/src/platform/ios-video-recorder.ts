import { writeFile } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { VideoRecorder } from "@autonoma/engine";
import type { Browser } from "webdriverio";
import { runAppium } from "./drivers/appium-error";

export class IosVideoRecorder extends VideoRecorder {
    private videoPath?: string;

    constructor(private readonly driver: Browser) {
        super();
    }

    protected async startRecording(): Promise<void> {
        this.logger.info("Starting iOS simulator recording via Appium");

        await runAppium(() =>
            this.driver.startRecordingScreen({
                timeLimit: 1800,
                videoType: "h264",
                videoQuality: "medium",
            }),
        );
    }

    protected async stopRecording(): Promise<void> {
        this.logger.info("Stopping iOS simulator recording via Appium");

        const recordingBase64 = await runAppium(() => this.driver.stopRecordingScreen());

        this.logger.info("Recording stopped, converting to buffer", { length: recordingBase64.length });
        const buff = Buffer.from(recordingBase64, "base64");

        const tmpDir = os.tmpdir();
        const videoPath = path.join(tmpDir, `video-${Date.now()}.mp4`);

        await writeFile(videoPath, buff);

        this.videoPath = videoPath;
        this.logger.info("Video file written successfully", { videoPath });
    }

    protected async computeVideoPath(): Promise<string> {
        if (this.videoPath == null) throw new NoVideoPathError();
        return this.videoPath;
    }
}

export class NoVideoPathError extends Error {
    constructor() {
        super("No video path found.");
    }
}
