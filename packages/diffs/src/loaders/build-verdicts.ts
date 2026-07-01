import type { Logger } from "@autonoma/logger";
import type { AffectedReason } from "../agents/diffs/affected-test";
import type { SnapshotRunContext } from "../review/snapshot";
import type { ScenarioData } from "../scenario-data";

/** Reviewer's verdict on a single test replay, plus the context needed to act on it. */
export interface RunReviewVerdict {
    runId: string;
    testSlug: string;
    testName: string;
    originalPrompt: string;
    runStatus: string;
    verdict: string;
    reviewReasoning: string;
    issueTitle?: string;
    issueDescription?: string;
    affectedReason?: AffectedReason;
    /**
     * The data the run's scenario actually seeded, materialized via the shared
     * scenario-data capability. Lets a consumer spot a failure rooted in a stale
     * test referencing data the scenario never created (vs a real bug). Absent
     * when the run had no scenario, UP failed, or the graph was empty.
     */
    scenario?: ScenarioData;
}

/**
 * Reduce a snapshot's per-run context (gathered by the `DiffJobContextLoader`)
 * to the actionable {@link RunReviewVerdict[]}.
 *
 * Two classes of run are dropped: passed runs (the test still works) and runs
 * without a completed reviewer verdict (nothing to attribute yet). The drops
 * are logged per-slug for observability.
 *
 * Each surviving run carries its materialized scenario data straight through, so
 * a consumer can tell a stale test (references data the scenario never created)
 * from a real bug.
 */
export function buildVerdicts(runs: SnapshotRunContext[], logger: Logger): RunReviewVerdict[] {
    const verdicts: RunReviewVerdict[] = [];
    const runsPassed: string[] = [];
    const runsActionable: string[] = [];
    const runsWithoutReview: string[] = [];

    for (const run of runs) {
        const slug = run.testSlug;

        if (run.runStatus === "success") {
            runsPassed.push(slug);
            continue;
        }

        if (run.review == null) {
            runsWithoutReview.push(slug);
            continue;
        }

        verdicts.push({
            runId: run.runId,
            testSlug: slug,
            testName: run.testName,
            originalPrompt: run.testPlanPrompt,
            runStatus: run.runStatus,
            verdict: run.review.verdict ?? "unknown",
            reviewReasoning: run.review.reasoning,
            affectedReason: run.affectedReason,
            issueTitle: run.review.issueTitle,
            issueDescription: run.review.issueDescription,
            scenario: run.scenario,
        });
        runsActionable.push(slug);
    }

    logger.info("Built verdicts", {
        actionable: verdicts.length,
        runsPassed,
        runsActionable,
        runsWithoutReview,
    });

    return verdicts;
}
