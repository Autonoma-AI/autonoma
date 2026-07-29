import { basename, join, relative } from "node:path";
import { glob } from "glob";

/**
 * The on-disk shape of a generated E2E test. These files ship to a platform
 * that requires markdown with YAML frontmatter, so the extension is a product
 * contract, not a local preference.
 *
 * Everything that writes or finds a test derives from here. A test stored under
 * any other name is invisible to the uploader, the reviewer, the dedupe scans
 * and the counter alike - it sits on disk, never reaches the platform, and is
 * regenerated as a duplicate - so the writer normalizes rather than trusting
 * the name the model supplied.
 */
export const TEST_FILE_EXT = ".md";

/** The suite's table of contents, written alongside the tests but not one. */
export const TEST_INDEX_FILE = `INDEX${TEST_FILE_EXT}`;

/** Directory under the output dir holding the generated suite. */
export const TESTS_DIR = "qa-tests";

/** Where structurally invalid tests are quarantined; not part of the suite. */
export const INVALID_DIR = "_invalid";

/** Recursive glob for every test file, for callers scanning the tests dir. */
export const TEST_FILE_GLOB = `**/*${TEST_FILE_EXT}`;

/** Whether a path is a generated test - the index file is not. */
export function isTestFile(path: string): boolean {
    return path.endsWith(TEST_FILE_EXT) && basename(path) !== TEST_INDEX_FILE;
}

/**
 * The suite as it exists on disk, as `qa-tests/...` paths relative to the run's
 * output directory, sorted.
 *
 * Read back rather than taken from the generator's own tally: by the time anyone
 * asks, the suite has also gained journey tests, lost tests the review cycle
 * deleted, and had invalid ones quarantined - none of which the tally knows
 * about. The one answer to "what tests exist", so the index, the uploader and
 * the counter cannot disagree.
 */
export async function listTestFiles(outputDir: string): Promise<string[]> {
    const absolute = await glob(join(outputDir, TESTS_DIR, TEST_FILE_GLOB));
    return absolute
        .filter((path) => isTestFile(path) && !path.includes(`/${INVALID_DIR}/`))
        .map((path) => relative(outputDir, path))
        .sort();
}

/**
 * The filename a test must be written under. The generating model supplies
 * this, and a model that returns "login-valid" or "login.markdown" would
 * otherwise produce a file nothing downstream can see.
 */
export function normalizeTestFilename(filename: string): string {
    const trimmed = filename.trim();
    if (trimmed.endsWith(TEST_FILE_EXT)) return trimmed;
    return `${trimmed.replace(/\.(markdown|mdx|txt)$/i, "")}${TEST_FILE_EXT}`;
}
