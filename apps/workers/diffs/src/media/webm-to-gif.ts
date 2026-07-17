import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "@autonoma/logger";
import ffmpeg from "@ffmpeg-installer/ffmpeg";

const execFileAsync = promisify(execFile);

// GitHub proxies every inline image through camo, which returns 404 for anything larger than 5 MiB - the
// image then renders as broken in the comment. So a clip is only useful if it stays under that ceiling.
// TARGET leaves headroom below the hard limit; a clip at or under TARGET is served comfortably.
const CAMO_MAX_BYTES = 5 * 1024 * 1024;
const TARGET_BYTES = 4.5 * 1024 * 1024;

// Speed the footage up so the whole run is watchable in a short, scannable clip. The clip spans the entire
// run (no duration cap), so its size scales with run length - a long run overflows camo's limit at full
// quality. These profiles trade quality for size, best first; only the passes needed to get under the
// ceiling actually run, so a short run still encodes once at full quality exactly as before.
const ENCODE_PROFILES = [
    { speed: 8, fps: 8, width: 1280, colors: 256 },
    { speed: 10, fps: 6, width: 1024, colors: 160 },
    { speed: 12, fps: 5, width: 800, colors: 96 },
] as const;

type EncodeProfile = (typeof ENCODE_PROFILES)[number];

/**
 * Turn a run recording buffer (WebM/MP4) into a short animated GIF via ffmpeg, bounded to stay under GitHub
 * camo's inline-image size limit. Tries progressively cheaper encodings (best quality first) and returns the
 * best one that fits; if even the smallest overflows, returns undefined so the caller falls back to the
 * static poster (which camo always serves). Best-effort: any ffmpeg failure also returns undefined.
 */
export async function webmToGif(video: Uint8Array, logger: Logger): Promise<Buffer | undefined> {
    let dir: string | undefined;
    try {
        dir = await mkdtemp(path.join(os.tmpdir(), "clip-"));
        const input = path.join(dir, "input");
        await writeFile(input, video);

        let smallest: { gif: Buffer; bytes: number; profile: EncodeProfile } | undefined;
        for (const profile of ENCODE_PROFILES) {
            const gif = await encodeGif(input, dir, profile);
            if (gif == null) continue;
            if (smallest == null || gif.length < smallest.bytes) {
                smallest = { gif, bytes: gif.length, profile };
            }
            if (gif.length <= TARGET_BYTES) {
                logger.info("Encoded GIF clip within size target", {
                    extra: { bytes: gif.length, width: profile.width, fps: profile.fps },
                });
                return gif;
            }
            logger.info("GIF clip over size target; retrying at a smaller profile", {
                extra: { bytes: gif.length, width: profile.width, fps: profile.fps },
            });
        }

        if (smallest != null && smallest.bytes <= CAMO_MAX_BYTES) {
            logger.info("Using smallest GIF clip under the camo limit", {
                extra: { bytes: smallest.bytes, width: smallest.profile.width, fps: smallest.profile.fps },
            });
            return smallest.gif;
        }

        logger.warn("GIF clip exceeds the camo limit at every profile; falling back to poster", {
            extra: { smallestBytes: smallest?.bytes, limit: CAMO_MAX_BYTES },
        });
        return undefined;
    } catch (error) {
        logger.warn("Could not generate GIF clip from run video; falling back to poster", { err: error });
        return undefined;
    } finally {
        if (dir != null) {
            await rm(dir, { recursive: true, force: true }).catch((err) => {
                logger.warn("Could not clean up GIF temp dir", { extra: { dir }, err });
            });
        }
    }
}

/** Encode one GIF at the given profile via the standard 2-pass palettegen/paletteuse. Returns undefined on failure. */
async function encodeGif(input: string, dir: string, profile: EncodeProfile): Promise<Buffer | undefined> {
    const palette = path.join(dir, `palette-${profile.width}.png`);
    const output = path.join(dir, `clip-${profile.width}.gif`);
    // setpts must precede fps so timestamps are compressed first, then resampled to FPS.
    const filters = `setpts=PTS/${profile.speed},fps=${profile.fps},scale=${profile.width}:-1:flags=lanczos`;
    await execFileAsync(ffmpeg.path, [
        "-y",
        "-i",
        input,
        "-vf",
        `${filters},palettegen=max_colors=${profile.colors}`,
        palette,
    ]);
    await execFileAsync(ffmpeg.path, [
        "-y",
        "-i",
        input,
        "-i",
        palette,
        "-lavfi",
        `${filters}[x];[x][1:v]paletteuse`,
        "-loop",
        "0",
        output,
    ]);
    return await readFile(output);
}
