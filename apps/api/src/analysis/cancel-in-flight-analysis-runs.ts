import { type Prisma, type PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { cancelAnalysisRun } from "@autonoma/workflow";

/** Which in-flight analysis runs to cancel: all of one application's, or all of one organization's. */
export type CancelScope = { applicationId: string } | { organizationId: string };

/**
 * Cancel the in-flight analysis runs of one application or one organization - used when an application is deleted,
 * unlinked from its repo, or its org disconnects GitHub. All three null `githubRepositoryId` on the affected
 * application(s), and a run already executing can last up to ~20 minutes, so it would otherwise re-read the now-null
 * repo id mid-flight and crash as a hard `failed` job (discarding any work it authored). Cancelling the run instead
 * lets it settle cleanly as `cancelled`.
 *
 * Best-effort: the DB mutation that triggered this has already committed, so a Temporal hiccup on one run is logged
 * and skipped rather than allowed to abort the caller. The containment path (a run that discovers its application
 * was unlinked mid-flight settles itself `cancelled`) is the safety net for any run this cannot reach in time.
 */
export async function cancelInFlightAnalysisRuns(db: PrismaClient, scope: CancelScope, logger: Logger): Promise<void> {
    const runningJobs = await db.analysisJob.findMany({
        where: whereForScope(scope),
        select: { snapshot: { select: { branchId: true } } },
    });
    const branchIds = [...new Set(runningJobs.map((job) => job.snapshot.branchId))];
    if (branchIds.length === 0) {
        logger.info("No in-flight analysis runs to cancel");
        return;
    }

    logger.info("Cancelling in-flight analysis runs", { extra: { branchCount: branchIds.length } });
    await Promise.all(
        branchIds.map((branchId) =>
            cancelAnalysisRun(branchId).catch((error) => {
                logger.warn("Failed to cancel in-flight analysis run", { extra: { branchId, error } });
            }),
        ),
    );
    logger.info("Requested cancellation of in-flight analysis runs", { extra: { branchCount: branchIds.length } });
}

/**
 * The running-job filter for a scope. An `AnalysisJob` reaches its application through `snapshot.branch`; that
 * traversal lives here, in one place, rather than being written out at each call site.
 */
function whereForScope(scope: CancelScope): Prisma.AnalysisJobWhereInput {
    if ("applicationId" in scope) {
        return { status: "running", snapshot: { branch: { applicationId: scope.applicationId } } };
    }
    return { status: "running", organizationId: scope.organizationId };
}
