import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { buildSdkUrl, DiffsRunPreparer } from "@autonoma/test-updates";
import { temporalPipelineWorkflows } from "@autonoma/workflow";
import type { PrepareDiffsRunInput, PrepareDiffsRunResult } from "@autonoma/workflow/activities";
import { env } from "../env";

const logger = rootLogger.child({ name: "prepareDiffsRun" });

// Built once and reused across activity invocations - the preparer is stateless over its deps (db + the shared
// Temporal pipeline-workflows collaborator + this worker's pipeline gates, which must mirror the API's).
const preparer = new DiffsRunPreparer({
    db,
    logger,
    workflows: temporalPipelineWorkflows,
    flags: {
        analysisAuthoritativeEnabled: env.ANALYSIS_AUTHORITATIVE_ENABLED,
        investigationShadowEnabled: env.INVESTIGATION_SHADOW_ENABLED,
    },
});

/**
 * Prepare + start the PR run for a PreviewKit-managed preview that just went ready, via the shared
 * {@link DiffsRunPreparer} - the SAME per-org analysis-vs-diffs sequence the API webhook paths run (create the
 * deployment + snapshot, then start the analysis pipeline for an analysis-enabled org, else the diffs job +
 * investigation shadow, superseding any in-flight run). Runs on the DIFFS queue; the runner reaches it only
 * through Temporal, never over HTTP.
 */
export async function prepareDiffsRun(input: PrepareDiffsRunInput): Promise<PrepareDiffsRunResult> {
    logger.info("Preparing PR run for PreviewKit preview", {
        branch: { branchId: input.branchId },
        extra: { headSha: input.headSha, url: input.url },
    });

    // Mirror the API: prefer the branch's active-snapshot head as the diff base, falling back to the PR base sha
    // the deploy event carries for a branch that has no active snapshot yet.
    const branch = await db.branch.findUnique({
        where: { id: input.branchId },
        select: { activeSnapshot: { select: { headSha: true } } },
    });
    const baseSha = branch?.activeSnapshot?.headSha ?? input.baseSha;

    const prepared = await preparer.prepare({
        branchId: input.branchId,
        organizationId: input.organizationId,
        headSha: input.headSha,
        baseSha,
        url: input.url,
        webhookUrl: buildSdkUrl(input.url),
    });

    if (prepared.skipped) {
        logger.info("PR run skipped: head already analyzed", { branch: { branchId: input.branchId } });
        return { skipped: true };
    }

    logger.info("PR run prepared", { snapshot: { snapshotId: prepared.snapshotId } });
    return { skipped: false, snapshotId: prepared.snapshotId };
}
