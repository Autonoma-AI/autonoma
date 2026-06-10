import type { Logger } from "@autonoma/logger";
import type { RunReviewVerdict } from "../agents/resolution/resolution-agent";
import type { SnapshotRunContext } from "../review/snapshot";

/**
 * Reduce a snapshot's per-run context (gathered by the `DiffJobContextLoader`)
 * to the actionable {@link RunReviewVerdict[]} the resolution agent handles.
 *
 * Three classes of run are dropped, mirroring what resolution can act on:
 * passed runs (the test still works), quarantined tests (excluded from replay,
 * owned by manual review), and runs without a completed reviewer verdict
 * (nothing to attribute yet). The drops are logged per-slug for observability.
 *
 * Each surviving run carries its materialized scenario data straight through, so
 * the agent can tell a stale test (references data the scenario never created)
 * from a real bug.
 */
export function buildVerdicts(runs: SnapshotRunContext[], logger: Logger): RunReviewVerdict[] {
    const verdicts: RunReviewVerdict[] = [];
    const runsPassed: string[] = [];
    const runsActionable: string[] = [];
    const runsWithoutReview: string[] = [];
    const runsQuarantined: string[] = [];

    for (const run of runs) {
        const slug = run.testSlug;

        if (run.quarantined) {
            runsQuarantined.push(slug);
            continue;
        }

        if (run.runStatus === "success") {
            runsPassed.push(slug);
            continue;
        }

        if (run.review == null) {
            runsWithoutReview.push(slug);
            continue;
        }

        const verdict: RunReviewVerdict = {
            runId: run.runId,
            testSlug: slug,
            testName: run.testName,
            originalPrompt: run.testPlanPrompt,
            runStatus: run.runStatus,
            verdict: run.review.verdict ?? "unknown",
            reviewReasoning: run.review.reasoning,
            affectedReason: run.affectedReason,
        };
        if (run.review.issueTitle != null) verdict.issueTitle = run.review.issueTitle;
        if (run.review.issueDescription != null) verdict.issueDescription = run.review.issueDescription;
        if (run.scenario != null) verdict.scenario = run.scenario;
        verdicts.push(verdict);
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
