import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "@autonoma/logger";
import ffmpeg from "@ffmpeg-installer/ffmpeg";

const execFileAsync = promisify(execFile);

/**
 * Remuxes a (finalized) Playwright-recorded WebM into a seekable WebM.
 *
 * Even once the recording is fully written, Playwright's WebM has no Cues (the
 * WebM seek index), so browsers can play it but not scrub it - dragging the
 * scrubber does nothing even when the file is fully buffered, because there is
 * no time -> byte-offset map. Rewriting the container with ffmpeg (`-c copy`, a
 * fast container rewrite with no re-encode) makes the muxer emit a proper
 * duration and Cues, which restores seeking.
 *
 * The input MUST already be finalized on disk (see WebVideoRecorder, which uses
 * video.saveAs() rather than video.path() for exactly this reason); ffmpeg
 * cannot parse a half-written recording.
 *
 * On any failure we fall back to the original recording: a non-seekable video is
 * still far better than failing the run over a finalization step.
 */
export async function finalizeWebm(inputPath: string, logger: Logger): Promise<string> {
    const outputPath = path.join(os.tmpdir(), `video-seekable-${Date.now()}.webm`);
    logger.info("Finalizing WebM for seekability", { extra: { inputPath, outputPath } });

    try {
        await execFileAsync(ffmpeg.path, ["-y", "-i", inputPath, "-c", "copy", outputPath]);
        logger.info("WebM finalized", { extra: { outputPath } });
        return outputPath;
    } catch (error) {
        logger.warn("Failed to finalize WebM, uploading original non-seekable recording", {
            extra: { inputPath, err: error },
        });
        return inputPath;
    }
}
