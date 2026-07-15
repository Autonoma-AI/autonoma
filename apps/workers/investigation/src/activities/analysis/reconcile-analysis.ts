import { db } from "@autonoma/db";
import { DeployedComparison } from "@autonoma/investigation";
import { logger as rootLogger } from "@autonoma/logger";
import type { ReconcileAnalysisInput, ReconcileAnalysisOutput } from "@autonoma/workflow/activities";

/**
 * Reconciler stage (stub). The real stage will dedup candidate findings and, in authoritative mode, file
 * enriched Bug/Issue rows. For now it produces the shadow-vs-diffs DeployedComparison placeholder (reading the
 * authoritative diffs job for the twin's head SHA) and files nothing - in shadow mode there are no user-facing
 * writes, and authoritative filing stays dormant until the cutover ships.
 */
export async function reconcileAnalysis(input: ReconcileAnalysisInput): Promise<ReconcileAnalysisOutput> {
    const { snapshotId, mode, candidates } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields
    // (mode, candidateCount) go in `extra`.
    const logger = rootLogger.child({
        name: "reconcileAnalysis",
        extra: { mode, candidateCount: candidates.length },
    });
    logger.info("Reconciler stage started (stub)");

    const comparison = await loadComparison(snapshotId);
    logger.info("Produced DeployedComparison placeholder", { extra: comparison });

    if (mode === "authoritative") {
        // Filing stays dormant until the authoritative cutover ships; log so an accidental authoritative run is visible.
        logger.warn("Authoritative reconcile is not implemented yet; filing nothing");
    }

    logger.info("Reconciler stage finished (stub); no findings filed");
    return { comparison, filedCount: 0 };
}

/**
 * The deployed (authoritative diffs) agent's outcome for the twin's head SHA, mapped to the skeleton's
 * comparison shape. Supplementary and best-effort: a missing diffs job or a query error degrades to
 * `found: false` rather than sinking the run.
 */
async function loadComparison(snapshotId: string): Promise<ReconcileAnalysisOutput["comparison"]> {
    const logger = rootLogger.child({ name: "reconcileAnalysis.loadComparison" });
    const twin = await db.branchSnapshot.findUnique({ where: { id: snapshotId }, select: { headSha: true } });
    const headSha = twin?.headSha;
    if (headSha == null) {
        logger.warn("Twin has no head SHA; skipping deployed comparison");
        return { found: false, deployedTestCount: 0 };
    }
    try {
        const deployed = await new DeployedComparison(db).byHeadSha(headSha);
        return { found: deployed.found, jobStatus: deployed.jobStatus, deployedTestCount: deployed.perTest.length };
    } catch (error) {
        logger.warn("Deployed comparison unavailable; returning an empty placeholder", { err: error });
        return { found: false, deployedTestCount: 0 };
    }
}
