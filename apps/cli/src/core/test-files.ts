import { basename } from "node:path";

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

/** Recursive glob for every test file, for callers scanning the tests dir. */
export const TEST_FILE_GLOB = `**/*${TEST_FILE_EXT}`;

/** Whether a path is a generated test - the index file is not. */
export function isTestFile(path: string): boolean {
    return path.endsWith(TEST_FILE_EXT) && basename(path) !== TEST_INDEX_FILE;
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
