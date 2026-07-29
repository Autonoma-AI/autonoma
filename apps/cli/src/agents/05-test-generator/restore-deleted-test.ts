import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { debugLog } from "../../core/debug";
import { captureLog } from "../../core/logs";

/**
 * Put a reviewed test back when the fix pass never rewrote it.
 *
 * The review cycle deletes a failing test before handing it to a fix agent, so
 * a rewrite lands on a clean path. When that agent times out, errors, or judges
 * the test unfixable and just finishes, nothing rewrites the file and the test
 * is gone for good - it isn't in the next review cycle, it isn't in the upload,
 * and only the (already-generated) INDEX.md still mentions it.
 *
 * Restoring is the safer side of the trade: a test that failed a semantic rubric
 * is still a structurally valid test the next cycle can retry, and the final
 * validation sweep quarantines it if it isn't. Silently dropping it is not
 * recoverable.
 *
 * Returns true when the original had to be put back, false when the fix agent
 * rewrote it - or when the restore itself failed. Never throws: this runs per
 * test inside a `Promise.all` over the fix batch, and the review cycle above has
 * no handler, so an escaping error would abort the whole test-generation step and
 * strand every test the cycle deleted but had not restored yet - the exact loss
 * this function exists to prevent.
 */
export async function restoreDeletedTest(testPath: string, originalContent: string): Promise<boolean> {
    try {
        await access(testPath);
        return false;
    } catch (err) {
        debugLog("Test absent after its fix pass - restoring the pre-review content", { testPath, err });
    }

    try {
        await mkdir(dirname(testPath), { recursive: true });
        await writeFile(testPath, originalContent, "utf-8");
        return true;
    } catch (err) {
        console.warn(`  [fix] Could not restore ${testPath}: ${err instanceof Error ? err.message : String(err)}`);
        captureLog("error", "Failed to restore a reviewed test - it stays missing from the suite", {
            source: "test-generator",
            step: "review-fix",
            path: testPath,
        });
        return false;
    }
}
