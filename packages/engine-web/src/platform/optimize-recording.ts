import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "@autonoma/logger";
import ffmpeg from "@ffmpeg-installer/ffmpeg";

const execFileAsync = promisify(execFile);

// The reviewer feeds this recording to a Gemini video model, which samples at 1 fps and bills per second of
// duration. Test recordings are mostly the agent waiting for network-idle, so resampling to 1 fps, dropping
// frames identical to their neighbour, then re-timestamping the survivors to 1-second spacing collapses those
// dead stretches to a single frame each - cutting billed frames ~85% while preserving every distinct state.
const OUTPUT_FPS = 1;

// mpdecimate thresholds, tuned on real recordings (median ~85% frame reduction, no meaningful state lost).
// A real localized change - a filled input, a ticking number, a toast - makes at least one 8x8 block differ
// hard, exceeding `hi`, which force-keeps the frame regardless of the others. `lo`/`frac` only govern the
// distributed-soft-change path, so raising them discards idle-dwell noise (VP8 keyframe shimmer, looping chart
// animations) without ever dropping a real step.
const MPDECIMATE_HI = 64 * 24;
const MPDECIMATE_LO = 64 * 12;
const MPDECIMATE_FRAC = 0.5;

// Near-lossless x264 with NO downscale - the reviewer must read small text (exact `$` amounts, badges), so we
// collapse *time*, never *pixels*.
const CRF = 14;
const PRESET = "slow";

/**
 * Produce a dead-time-stripped mp4 from a run recording on disk: resample to 1 fps, drop frames identical to
 * their neighbour, then recompress the timeline so held stretches collapse to ~1 frame. The output's duration
 * (seconds) equals its distinct-frame count - exactly what the video model bills - so a mostly-idle 3-minute
 * run bills a handful of frames instead of ~180. It also backs the UI's "optimized" playback toggle.
 *
 * Best-effort: returns `undefined` if ffmpeg fails or the result is not smaller than the input, so the caller
 * keeps only the original recording. Never throws.
 */
export async function optimizeRecording(inputPath: string, logger: Logger): Promise<Buffer | undefined> {
    let dir: string | undefined;
    try {
        const original = await readFile(inputPath);
        dir = await mkdtemp(path.join(os.tmpdir(), "opt-rec-"));
        const output = path.join(dir, "output.mp4");

        // Order matters: fps first (align with the model's sampling), then mpdecimate (drop held frames at that
        // granularity), then setpts (re-timestamp survivors to 1s spacing so the duration actually collapses).
        const filters = [
            `fps=${OUTPUT_FPS}`,
            `mpdecimate=hi=${MPDECIMATE_HI}:lo=${MPDECIMATE_LO}:frac=${MPDECIMATE_FRAC}`,
            "setpts=N/TB",
        ].join(",");

        await execFileAsync(ffmpeg.path, [
            "-y",
            "-i",
            inputPath,
            "-vf",
            filters,
            "-r",
            String(OUTPUT_FPS),
            "-c:v",
            "libx264",
            "-crf",
            String(CRF),
            "-preset",
            PRESET,
            "-pix_fmt",
            "yuv420p",
            "-an",
            output,
        ]);

        const optimized = await readFile(output);
        if (optimized.length >= original.length) {
            logger.info("Optimized recording is not smaller than the original; keeping only the original", {
                extra: { originalBytes: original.length, optimizedBytes: optimized.length },
            });
            return undefined;
        }

        logger.info("Optimized run recording", {
            extra: { originalBytes: original.length, optimizedBytes: optimized.length },
        });
        return optimized;
    } catch (error) {
        logger.warn("Could not optimize run recording; keeping only the original", { err: error });
        return undefined;
    } finally {
        if (dir != null) {
            await rm(dir, { recursive: true, force: true }).catch((err) => {
                logger.warn("Could not clean up optimize-recording temp dir", { extra: { dir }, err });
            });
        }
    }
}
