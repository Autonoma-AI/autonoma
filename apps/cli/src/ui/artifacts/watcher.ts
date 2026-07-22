import { watch, type FSWatcher } from "node:fs";
import { debugLog } from "../../core/debug";

const DEBOUNCE_MS = 120;

/**
 * Watch the output directory and report changed paths (relative to it),
 * debounced per path. This is the backstop that catches files written outside
 * the agent tool loop (savePages, recipe submit, INDEX.md). The primary trigger
 * is still the write_file/write_test events the store gets from onStepFinish.
 *
 * Falls back to a non-recursive watch where recursive isn't supported.
 */
export function watchOutputDir(outputDir: string, onChange: (relPath: string) => void): () => void {
    const watchers: FSWatcher[] = [];
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const fire = (rel: string) => {
        const prev = timers.get(rel);
        if (prev) clearTimeout(prev);
        timers.set(
            rel,
            setTimeout(() => {
                timers.delete(rel);
                onChange(rel);
            }, DEBOUNCE_MS),
        );
    };

    const handler = (_event: string, filename: string | Buffer | null) => {
        if (filename == null) return;
        fire(typeof filename === "string" ? filename : filename.toString());
    };

    try {
        watchers.push(watch(outputDir, { recursive: true }, handler));
    } catch (err) {
        debugLog("Recursive fs.watch unavailable, falling back to flat watch", { outputDir, err });
        try {
            watchers.push(watch(outputDir, handler));
        } catch (err2) {
            debugLog("No fs.watch available; write events alone drive the UI", { outputDir, err: err2 });
        }
    }

    return () => {
        for (const w of watchers) {
            try {
                w.close();
            } catch (err) {
                debugLog("Failed to close fs watcher", { outputDir, err });
            }
        }
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
    };
}
