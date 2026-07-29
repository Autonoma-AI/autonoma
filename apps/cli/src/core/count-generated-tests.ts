import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { debugLog } from "./debug";

const TESTS_DIR = "qa-tests";
/** The suite's own table of contents, not a test - it lives alongside them. */
const INDEX_FILE = "INDEX.md";

/**
 * How many E2E tests the run produced.
 *
 * Counted from the files on disk, which are the only trustworthy source. The
 * `total_tests` in qa-tests/INDEX.md comes from a counter accumulated during
 * generation, so it drifts from reality whenever the two diverge - a resumed
 * run, a skipped node, journey tests appended after the index was written.
 */
export async function countGeneratedTests(outputDir: string): Promise<number> {
    const dir = join(outputDir, TESTS_DIR);
    try {
        const entries = await readdir(dir, { recursive: true });
        return entries.map((e) => String(e)).filter((e) => e.endsWith(".md") && basename(e) !== INDEX_FILE).length;
    } catch (err) {
        debugLog("Failed to read the generated tests directory, reporting zero", { dir, err });
        return 0;
    }
}
