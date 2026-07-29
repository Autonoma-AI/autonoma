import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { debugLog } from "./debug";
import { isTestFile, TESTS_DIR } from "./test-files";

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
        return entries.map(String).filter(isTestFile).length;
    } catch (err) {
        debugLog("Failed to read the generated tests directory, reporting zero", { dir, err });
        return 0;
    }
}
