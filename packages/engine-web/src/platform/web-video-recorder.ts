import os from "node:os";
import path from "node:path";
import { VideoRecorder } from "@autonoma/engine";
import type { Page } from "playwright";
import { runPlaywright } from "./drivers/playwright-error";
import { finalizeWebm } from "./finalize-webm";

export class NoPageVideoError extends Error {
    constructor() {
        super(
            "The page does not have a video stream. Remember to set the video recording directory when creating the browser context.",
        );
    }
}

export class WebVideoRecorder extends VideoRecorder {
    constructor(private readonly page: Page) {
        super();
    }

    protected async startRecording(): Promise<void> {
        // In web, this is a no-op: video recording starts automatically when the page is created.
        // We just validate that the page has a video stream.
        if (this.page.video() == null) throw new NoPageVideoError();
    }

    protected async stopRecording(): Promise<void> {
        if (this.page.isClosed()) return;
        await runPlaywright(() => this.page.close());
    }

    protected async computeVideoPath(): Promise<string> {
        const recordedPath = await this.resolveRecordedPath();

        // Even once finalized, Playwright's WebM has no Cues (the seek index), so
        // the browser can play it but not scrub it. Remux it into a seekable file
        // before upload.
        return finalizeWebm(recordedPath, this.logger);
    }

    private async resolveRecordedPath(): Promise<string> {
        const video = this.page.video();
        if (video == null) throw new NoPageVideoError();

        // Never use video.path() here: the context-level recording is only flushed
        // to disk when the browser context closes (which happens during cleanup,
        // after this runs), so path() returns a half-written, unreadable file - the
        // root cause of the truncated, non-seekable recordings. saveAs() waits for
        // the recording to finalize (the page is already closed) and writes a
        // complete file we can safely remux.
        const savePath = path.join(os.tmpdir(), `video-${Date.now()}.webm`);
        await runPlaywright(() => video.saveAs(savePath));
        return savePath;
    }
}
