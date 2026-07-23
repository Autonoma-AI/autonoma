import { existsSync } from "node:fs";
import { type CheckoutCoords, ensureCachedCheckout } from "./checkout";
import { contextStripPatchPath } from "./corpus";
import { copyTree, git } from "./git";

/**
 * Stage one read-only context repo of a polyrepo case into `destDir`: clone-cached
 * checkout -> copy -> apply this repo's context strip if the case ships one.
 *
 * A context repo must meet the SAME realism bar as the target: the staged tree must
 * carry no trace of the SDK integration. If `cases/<caseRepo>/context-strips/<repo>.patch`
 * exists it is applied here (sha -> clean); if the pinned context sha already predates
 * the integration there is nothing to strip and the patch is simply absent. Used by
 * both eval layers so the target and its siblings are cleaned the same way.
 */
export async function stageContextCheckout(caseRepo: string, coords: CheckoutCoords, destDir: string): Promise<void> {
    const cacheDir = await ensureCachedCheckout(coords);
    await copyTree(cacheDir, destDir);

    const stripPath = contextStripPatchPath(caseRepo, coords.repo);
    if (existsSync(stripPath)) {
        await git(destDir, ["apply", "--whitespace=nowarn", stripPath]);
    }
}
