const QA_TESTS_SEGMENT = "qa-tests";

/**
 * The folder key the API dedupes an uploaded test case on (`folder::name`) must match
 * exactly what the planner CLI sends, or a re-upload creates a second copy of every test.
 *
 * The CLI globs from inside `qa-tests/`, so its folder is relative to that root
 * (`dashboard/cards`). A directory upload's path still carries the leading
 * `qa-tests/` (or `autonoma/qa-tests/`) segment, so drop everything up to and including
 * that segment, then drop the filename, to land on the same key. Matching `qa-tests`
 * as a whole path segment (not a substring) keeps a dir like `my-qa-tests/` from being
 * mistaken for the marker.
 *
 * @param path the file's path within the selected directory, e.g.
 *   `qa-tests/dashboard/cards/create-physical-card.md`
 */
export function testCaseFolder(path: string): string | undefined {
    const segments = path.split("/");
    const markerIdx = segments.lastIndexOf(QA_TESTS_SEGMENT);
    // Everything after the qa-tests root, minus the filename. With no qa-tests segment
    // (already CLI-relative) fall back to the whole path minus the filename.
    const start = markerIdx >= 0 ? markerIdx + 1 : 0;
    const dir = segments.slice(start, -1).join("/");
    return dir.length > 0 ? dir : undefined;
}
