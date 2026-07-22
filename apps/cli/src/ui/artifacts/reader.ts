import { open, readFile, stat } from "node:fs/promises";
import { debugLog } from "../../core/debug";
import type { ContentKind } from "../types";
import { kindOf } from "./registry";

/** Above this, only the tail is read so the hero never blocks on a huge file. */
const LARGE_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;

export interface LiveContent {
    text: string;
    kind: ContentKind;
    truncated: boolean;
}

/**
 * Refresh-from-disk for the hero panel. Reads the whole file, or just its tail
 * when it's large. Returns undefined if the file can't be read (e.g. deleted
 * between the watch event and the read).
 */
export async function readForLive(absPath: string): Promise<LiveContent | undefined> {
    try {
        const info = await stat(absPath);
        if (!info.isFile()) return undefined;
        const kind = kindOf(absPath);

        if (info.size <= LARGE_BYTES) {
            const text = await readFile(absPath, "utf-8");
            return { text, kind, truncated: false };
        }

        // Tail-read large files: open and read the last TAIL_BYTES.
        const fh = await open(absPath, "r");
        try {
            const start = Math.max(0, info.size - TAIL_BYTES);
            const buf = Buffer.alloc(info.size - start);
            await fh.read(buf, 0, buf.length, start);
            // Drop the partial first line so we start clean.
            const raw = buf.toString("utf-8");
            const nl = raw.indexOf("\n");
            const text = nl >= 0 ? raw.slice(nl + 1) : raw;
            return { text, kind, truncated: true };
        } finally {
            await fh.close();
        }
    } catch (err) {
        debugLog("Hero panel could not read file", { absPath, err });
        return undefined;
    }
}
