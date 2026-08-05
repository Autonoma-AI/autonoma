import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { resolveAnalysisBase, startAnalysisRun } from "@autonoma/test-updates";
import type { OpenAnalysisRunInput, OpenAnalysisRunOutput } from "@autonoma/workflow/activities";

const logger = rootLogger.child({ name: "openAnalysisRun" });

export class NoAnalysisBaseError extends Error {
    constructor(branchId: string) {
        super(`Branch ${branchId} has no analysis base: no active snapshot, and the trigger knew no base sha`);
    }
}

/**
 * Deliberately URL-free: a previewkit run opens its run before the preview exists, since whether one ever will is
 * what the build gate is about to decide. A customer-deployed run opens it with the deployment already recorded.
 */
export async function openAnalysisRun(input: OpenAnalysisRunInput): Promise<OpenAnalysisRunOutput> {
    const { branchId, headSha } = input;
    logger.info("Opening the analysis run", { branch: { branchId }, extra: { headSha } });

    const { baseSha, alreadyAnalyzed } = await resolveAnalysisBase({
        db,
        branchId,
        headSha,
        fallbackBaseSha: input.baseSha,
    });

    // A re-delivered trigger for an already-analyzed head has nothing new to diff. A previewkit run still builds for
    // it - the customer asked for a fresh preview of a commit we have already judged - so this reports the skip
    // rather than suppressing the run outright.
    if (alreadyAnalyzed) {
        logger.info("Run skipped: head already analyzed", { branch: { branchId } });
        return { skipped: true };
    }
    if (baseSha == null) throw new NoAnalysisBaseError(branchId);

    const snapshotId = await startAnalysisRun({ db, logger, branchId, headSha, baseSha });

    logger.info("Analysis run opened", { snapshot: { snapshotId } });
    return { skipped: false, snapshotId };
}
