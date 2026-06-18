import { db } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import type { RejectedCandidateDecision } from "@autonoma/workflow/activities";

/** A candidate graduated into a freshly-minted test case this turn. */
export interface AcceptedCandidateLink {
    candidateId: string;
    testCaseId: string;
}

export interface ReconcileFirstTurnOutcomesParams {
    snapshotId: string;
    /** Candidates the agent accepted via add_test, paired with their minted test case. */
    acceptedCandidateLinks: AcceptedCandidateLink[];
    /** Candidates the agent explicitly rejected, with reasoning. */
    rejectedCandidates: RejectedCandidateDecision[];
    logger: Logger;
}

/**
 * The first-turn apply tail. After iteration 1's healing actions are applied,
 * this decides every candidate so the "Resolution" snapshot stage still shows
 * its data:
 *
 *   - Accepted candidates are marked accepted against their minted test case;
 *     every other candidate is rejected (explicit rejections keep their
 *     reasoning) ("Candidate decisions").
 *
 * The affected-test -> regeneration link is no longer done here: it now happens
 * at the moment the regeneration is queued (see applyUpdatePlan). Candidate
 * marking is all that remains, and it is removed by the candidate-free cut-over.
 *
 * Runs only on iteration 1. Naturally a no-op for onboarding (no TestCandidate
 * rows exist) and for diffs turns with no candidates.
 */
export async function reconcileFirstTurnOutcomes(params: ReconcileFirstTurnOutcomesParams): Promise<void> {
    const { snapshotId, acceptedCandidateLinks, rejectedCandidates, logger } = params;
    logger.info("Reconciling first-turn outcomes", {
        snapshotId,
        acceptedCandidates: acceptedCandidateLinks.length,
        rejectedCandidates: rejectedCandidates.length,
    });

    await markAcceptedCandidates(snapshotId, acceptedCandidateLinks, logger);
    await rejectRemainingCandidates(snapshotId, rejectedCandidates, logger);
}

async function markAcceptedCandidates(
    snapshotId: string,
    accepted: AcceptedCandidateLink[],
    logger: Logger,
): Promise<void> {
    if (accepted.length === 0) {
        logger.info("No candidates accepted this turn");
        return;
    }

    for (const { candidateId, testCaseId } of accepted) {
        await db.testCandidate
            .updateMany({
                where: { id: candidateId, snapshotId },
                data: { status: "accepted", acceptedTestCaseId: testCaseId },
            })
            .catch((error) => {
                logger.warn("Failed to mark candidate accepted", { candidateId, testCaseId, error });
            });
    }
}

/**
 * Rejects every still-pending candidate. Candidates the agent explicitly rejected
 * get their reasoning persisted; any remaining pending ones (the result tool
 * forces every candidate to be decided, so this is a safety net) are bulk-rejected
 * without a reason. Runs after {@link markAcceptedCandidates}, so accepted
 * candidates are already out of the "pending" set and untouched.
 */
async function rejectRemainingCandidates(
    snapshotId: string,
    rejected: RejectedCandidateDecision[],
    logger: Logger,
): Promise<void> {
    for (const { candidateId, reasoning } of rejected) {
        await db.testCandidate
            .updateMany({
                where: { id: candidateId, snapshotId, status: "pending" },
                data: { status: "rejected", rejectionReasoning: reasoning },
            })
            .catch((error) => {
                logger.warn("Failed to persist candidate rejection reasoning", { candidateId, error });
            });
    }

    await db.testCandidate.updateMany({
        where: { snapshotId, status: "pending" },
        data: { status: "rejected" },
    });
}
