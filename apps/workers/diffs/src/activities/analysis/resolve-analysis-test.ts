import { db } from "@autonoma/db";

/** A test's own rows on one snapshot, as the Investigator's row-local write activities need them. */
export interface AnalysisTestTarget {
    testCaseId: string;
    /** The plan the assignment currently points at - what a later revert restores. */
    planId?: string;
    /** The scenario that plan pins, when it pins one. */
    scenarioId?: string;
    /** The owning organization, verified by the suite store when the snapshot was opened. */
    organizationId: string;
}

/**
 * Resolve a test's own `(snapshot, testCase)` rows from its slug - the single lookup every row-local Investigator write
 * (self-heal, revert) starts from. Returns undefined when the slug has no assignment on the snapshot, and deliberately
 * does not log that miss: what it means differs per write, so the caller reports it in its own words.
 */
export async function resolveAnalysisTestTarget(
    snapshotId: string,
    slug: string,
): Promise<AnalysisTestTarget | undefined> {
    const assignment = await db.testCaseAssignment.findFirst({
        where: { snapshotId, testCase: { slug } },
        select: {
            testCaseId: true,
            planId: true,
            plan: { select: { scenarioId: true } },
            testCase: { select: { organizationId: true } },
        },
    });
    if (assignment == null) return undefined;
    return {
        testCaseId: assignment.testCaseId,
        planId: assignment.planId ?? undefined,
        scenarioId: assignment.plan?.scenarioId ?? undefined,
        organizationId: assignment.testCase.organizationId,
    };
}
