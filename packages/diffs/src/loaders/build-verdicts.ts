import type { Logger } from "@autonoma/logger";
import type { AffectedReason } from "../agents/diffs/affected-test";
import type { RunReviewVerdict } from "../agents/resolution/resolution-agent";

/**
 * Shape of an {@link db.affectedTest} row joined with its test case, run, and
 * run review used to build {@link RunReviewVerdict}s for the resolution agent.
 * The Prisma `select` clause that produces this shape lives next to the
 * caller(s) of {@link buildVerdicts}.
 */
export interface AffectedTestWithRun {
    testCaseId: string;
    affectedReason: AffectedReason;
    runId: string | null;
    testCase: {
        id: string;
        name: string;
        slug: string;
        assignments: { quarantineIssueId: string | null }[];
    };
    run: {
        id: string;
        status: string;
        assignment: { plan: { prompt: string } | null } | null;
        runReview: {
            status: string;
            verdict: string | null;
            reasoning: string | null;
            issue: { title: string; description: string } | null;
        } | null;
    } | null;
}

/**
 * Transforms loaded {@link AffectedTestWithRun} rows into the
 * {@link RunReviewVerdict[]} the resolution agent consumes. Passed runs,
 * quarantined tests, and runs without a completed review are filtered out;
 * the result is logged for observability.
 */
export function buildVerdicts(affectedTests: AffectedTestWithRun[], logger: Logger): RunReviewVerdict[] {
    const verdicts: RunReviewVerdict[] = [];
    const runsPassed: string[] = [];
    const runsActionable: string[] = [];
    const runsWithoutReview: string[] = [];
    const runsQuarantined: string[] = [];

    for (const affected of affectedTests) {
        const run = affected.run;
        if (run == null) continue;

        const slug = affected.testCase.slug;

        if (affected.testCase.assignments[0]?.quarantineIssueId != null) {
            runsQuarantined.push(slug);
            continue;
        }

        if (run.status === "success") {
            runsPassed.push(slug);
            continue;
        }

        const review = run.runReview;
        if (review == null || review.status !== "completed") {
            runsWithoutReview.push(slug);
            continue;
        }

        verdicts.push({
            runId: run.id,
            testSlug: slug,
            testName: affected.testCase.name,
            originalPrompt: run.assignment?.plan?.prompt ?? "",
            runStatus: run.status,
            verdict: review.verdict ?? "unknown",
            reviewReasoning: review.reasoning ?? "",
            issueTitle: review.issue?.title ?? undefined,
            issueDescription: review.issue?.description ?? undefined,
            affectedReason: affected.affectedReason,
        });
        runsActionable.push(slug);
    }

    logger.info("Built verdicts", {
        actionable: verdicts.length,
        runsPassed,
        runsActionable,
        runsWithoutReview,
        runsQuarantined,
    });

    return verdicts;
}
